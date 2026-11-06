// The agent loop for one guest message.
// Sends the message to the model; if the model asks for a tool, runs it and
// sends the result back; repeats until the model answers with text, at most
// five steps. Records the request in data/requests.json exactly once.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MAX_STEPS = 5;

// data/ lives at the project root (one level up from server/).
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(projectRoot, "data");
const requestsFile = join(dataDir, "requests.json");
const bookingsFile = join(dataDir, "bookings.csv");

// The one tool the model may call.
const logRequestTool = {
  name: "log_request",
  description:
    "Records the request in the hotel's log. Call it exactly once per guest message, before your final answer.",
  input_schema: {
    type: "object",
    properties: {
      department: {
        type: "string",
        enum: [
          "Reservations",
          "Billing & Payments",
          "Front Desk & Guest Services",
          "Housekeeping & Maintenance",
          "Restaurant & Events",
          "Complaints & Feedback",
        ],
      },
      urgency: { type: "string", enum: ["high", "normal"] },
      summary: { type: "string" },
      status: { type: "string", enum: ["ANSWERED", "ESCALATED"] },
    },
    required: ["department", "urgency", "summary", "status"],
  },
};

// The second tool. The model supplies no input; the backend passes the form's
// e-mail to the function.
const lookupBookingTool = {
  name: "lookup_booking",
  description:
    "Returns the guest's own reservation: dates, room type, breakfast, rate and payment status, or that no booking was found. Use it only when the answer depends on the guest's booking.",
  input_schema: {
    type: "object",
    properties: {},
  },
};

// Parse one CSV line, honouring double-quoted fields that may contain commas.
function parseCsvLine(line) {
  const fields = [];
  let value = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          value += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        value += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(value);
      value = "";
    } else {
      value += ch;
    }
  }
  fields.push(value);
  return fields.map((f) => f.trim());
}

// Read data/bookings.csv and return the row whose email matches the form's
// e-mail, as a plain object keyed by the CSV header. Returns null if the file
// is missing or no row matches.
async function lookupBooking(email) {
  let text;
  try {
    text = await readFile(bookingsFile, "utf8");
  } catch {
    return null; // No bookings file.
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) return null; // Header only, or empty.

  const header = parseCsvLine(lines[0]);
  const emailIndex = header.findIndex((h) => h.toLowerCase() === "email");
  if (emailIndex === -1) return null; // No email column.

  const target = email.trim().toLowerCase();
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if ((cells[emailIndex] || "").toLowerCase() === target) {
      const row = {};
      header.forEach((key, j) => {
        row[key] = cells[j] ?? "";
      });
      return row;
    }
  }
  return null; // No matching booking.
}

// Append one row to data/requests.json, creating the file if needed.
async function appendRow(row) {
  await mkdir(dataDir, { recursive: true });

  let rows = [];
  try {
    const text = await readFile(requestsFile, "utf8");
    rows = JSON.parse(text);
    if (!Array.isArray(rows)) rows = [];
  } catch {
    // No file yet, or it was empty/invalid. Start a fresh list.
    rows = [];
  }

  rows.push(row);
  await writeFile(requestsFile, JSON.stringify(rows, null, 2) + "\n");
}

// Run the loop for one guest message and return the model's final text.
export async function runAgent({ name, email, message, systemPrompt, anthropic }) {
  const messages = [
    {
      role: "user",
      content: `Name: ${name}\nEmail: ${email}\nMessage: ${message}`,
    },
  ];

  // What the model logged for this request, if anything.
  let logged = null;
  let finalText = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-5-5",
      max_tokens: 1024,
      system: systemPrompt,
      tools: [logRequestTool, lookupBookingTool],
      messages,
    });

    // Keep the model's turn in the conversation.
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b) => b.type === "tool_use");

    // No tool call: the model has answered. Take its text and stop.
    if (toolUses.length === 0) {
      const textBlock = response.content.find((b) => b.type === "text");
      finalText = textBlock ? textBlock.text : "";
      break;
    }

    // Run each requested tool and send the results back.
    const results = [];
    for (const toolUse of toolUses) {
      let resultText;
      if (toolUse.name === "log_request") {
        if (logged) {
          // Only one log_request is allowed per message.
          resultText = "already logged";
        } else {
          const input = toolUse.input || {};
          logged = {
            department: input.department ?? "",
            urgency: input.urgency ?? "",
            summary: input.summary ?? "",
            status: input.status ?? "",
          };
          resultText = JSON.stringify({ ok: true });
        }
      } else if (toolUse.name === "lookup_booking") {
        // The model supplies no e-mail; the backend uses the form's e-mail.
        const booking = await lookupBooking(email);
        resultText = booking
          ? JSON.stringify(booking)
          : JSON.stringify({ found: false });
      } else {
        resultText = "unknown tool";
      }

      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: resultText,
      });
    }

    messages.push({ role: "user", content: results });
  }

  // Build the row. If the model never logged, save as ESCALATED with no
  // department and a note, rather than crashing.
  const base = {
    time: new Date().toISOString(),
    name,
    email,
    message,
  };

  let row;
  if (logged) {
    row = {
      ...base,
      department: logged.department,
      urgency: logged.urgency,
      summary: logged.summary,
      status: logged.status,
      reply: finalText,
    };
  } else {
    row = {
      ...base,
      department: "",
      urgency: "",
      summary: "",
      status: "ESCALATED",
      note: "no log_request call",
      reply: finalText,
    };
  }

  await appendRow(row);

  return finalText;
}
