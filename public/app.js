// Guest page behaviour: load the weather strip, send the form, show the reply.

// --- weather strip ----------------------------------------------------------
const WEATHER_URL =
  "https://api.open-meteo.com/v1/forecast" +
  "?latitude=41.39&longitude=2.17" +
  "&daily=temperature_2m_max,precipitation_probability_max" +
  "&timezone=Europe%2FMadrid&forecast_days=7";

// Turn "2026-11-06" into a short, friendly label like "Fri 6 Nov".
function formatDate(isoDate) {
  const date = new Date(isoDate + "T00:00:00");
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

async function loadWeather() {
  const strip = document.getElementById("weather-strip");
  try {
    const res = await fetch(WEATHER_URL);
    if (!res.ok) throw new Error("Weather request failed");
    const data = await res.json();
    const daily = data.daily;

    // daily.time[0] is today. The three arrays line up by index.
    const cells = daily.time.map((date, i) => {
      const temp = Math.round(daily.temperature_2m_max[i]);
      const rain = daily.precipitation_probability_max[i];
      return (
        '<div class="weather-day">' +
        '<div class="day-date">' + formatDate(date) + "</div>" +
        '<div class="day-temp">' + temp + "\u00B0C</div>" +
        '<div class="day-rain">Rain ' + rain + "%</div>" +
        "</div>"
      );
    });

    strip.innerHTML = cells.join("");
  } catch {
    strip.innerHTML =
      '<p class="weather-error">The weather is not available right now.</p>';
  }
}

// --- message form -----------------------------------------------------------
async function sendMessage(event) {
  event.preventDefault();

  const form = event.target;
  const button = document.getElementById("send");
  const replyBox = document.getElementById("reply");

  const name = form.name.value.trim();
  const email = form.email.value.trim();
  const message = form.message.value.trim();

  // All three fields are required.
  if (!name || !email || !message) {
    replyBox.innerHTML =
      '<p class="reply-error">Please fill in all three fields.</p>';
    return;
  }

  button.disabled = true;
  replyBox.innerHTML = "<p>Sending your message.</p>";

  try {
    const res = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, message }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Request failed");

    const box = document.createElement("div");
    box.className = "reply-box";
    box.textContent = data.reply;
    replyBox.innerHTML = "";
    replyBox.appendChild(box);
  } catch (err) {
    replyBox.innerHTML =
      '<p class="reply-error">' +
      (err.message || "Sorry, something went wrong.") +
      "</p>";
  } finally {
    button.disabled = false;
  }
}

document.getElementById("message-form").addEventListener("submit", sendMessage);
loadWeather();
