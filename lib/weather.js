// open-meteo: free, no api key
const CODES = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "rain showers", 81: "rain showers", 82: "heavy showers", 85: "snow showers", 86: "snow showers",
  95: "thunderstorm", 96: "thunderstorm + hail", 99: "thunderstorm + hail",
};

export async function geocode(city) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`);
  if (!r.ok) throw new Error("location service unavailable");
  const g = (await r.json()).results?.[0];
  if (!g) return null;
  return { city: [g.name, g.admin1].filter(Boolean).join(", "), lat: g.latitude, lon: g.longitude, tz: g.timezone || "UTC" };
}

export async function forecast(lat, lon, tz) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=8&timezone=${encodeURIComponent(tz)}`;
  const r = await fetch(url, { next: { revalidate: 1800 } });
  if (!r.ok) throw new Error(`weather service error ${r.status}`);
  const d = (await r.json()).daily;
  return d.time.map((date, i) => ({
    date,
    summary: CODES[d.weather_code[i]] ?? "mixed",
    code: d.weather_code[i],
    high: Math.round(d.temperature_2m_max[i]),
    low: Math.round(d.temperature_2m_min[i]),
    rain_chance: d.precipitation_probability_max[i] ?? 0,
    wind_mph: Math.round(d.wind_speed_10m_max[i]),
    sunrise: String(d.sunrise[i]).slice(11, 16),
    sunset: String(d.sunset[i]).slice(11, 16),
  }));
}
