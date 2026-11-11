// nearby named hiking trails from openstreetmap (overpass api, free, no key)
const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

const rad = (d) => (d * Math.PI) / 180;
function milesBetween(lat1, lon1, lat2, lon2) {
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}

export async function nearbyTrails(lat, lon, radiusMiles = 20) {
  const r = Math.round(radiusMiles * 1609);
  const q =
    `[out:json][timeout:20];(` +
    `relation["route"="hiking"]["name"](around:${r},${lat},${lon});` +
    `way["highway"~"^(path|footway|track)$"]["name"~"trail",i](around:${r},${lat},${lon});` +
    `);out tags center 80;`;

  let data;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "swiftly-planner/1.0" },
        body: "data=" + encodeURIComponent(q),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        data = await res.json();
        break;
      }
    } catch {}
  }
  if (!data) throw new Error("trail search is unavailable right now");

  const seen = new Set();
  const trails = [];
  for (const el of data.elements || []) {
    const name = el.tags?.name;
    const c = el.center || (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    if (!name || !c || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    trails.push({
      name,
      miles_away: Math.round(milesBetween(lat, lon, c.lat, c.lon) * 10) / 10,
      length_km: el.tags.distance ? Number.parseFloat(el.tags.distance) || undefined : undefined,
      type: el.type === "relation" ? "hiking route" : "trail",
    });
  }
  // real hiking routes first, then closest
  return trails.sort((a, b) => (a.type === b.type ? a.miles_away - b.miles_away : a.type === "hiking route" ? -1 : 1)).slice(0, 8);
}
