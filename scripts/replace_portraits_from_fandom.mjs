#!/usr/bin/env node
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const portraits = path.join(root, "Heroes", "Portrait");
const endpoint = "https://mobile-legends.fandom.com/api.php";
const dryRun = process.argv.includes("--dry-run");
const normalize = (text) => text.toLowerCase().replaceAll("&", "and").replace(/[^a-z0-9]/g, "");
const normalizeLoose = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const filenameAliases = new Map(Object.entries({
  "Minotaur|Taurus": "Minotaur-Tauros.png",
  "Moskov|Infernal Wrymlord": "Moskov-Infernal-Wyrmlord.png",
  "Valir|Shikigami Sumonner": "Valir-Shikigami-Summoner.png",
  "Selena|Curse of Cinder": "Selena-Curse-of-Cinders.png",
  "Claude|Earth's Mightiest": "Claude-Earth-s-MightiestM.png",
  "Hanzo|Insidious Tutor": "Hanzo-Insidous-Tutor.png",
  "Dyrroth|Ruins Scavenger": "Dyrroth-Scavenger.png",
  "Silvanna|Meowkin Warden": "Silvanna-Meowin-Warden.png",
  "Paquito|Fist of Light": "Paquito-First-of-Light.png",
  "Julian|Meowkin Tracker": "Julian-Meowkin.png",
  "Julian|Kurapika": "Julian-Kurapika-of-Kurta.png",
  "Fredrinn|Royal Marshal": "Fredrinn-Royal-Marshall.png",
  "Suyou|Sasuke Uchiha": "Suyou-Sasuke.png",
  "Lukas|Naruto Uzumaki": "Lukas-Naruto.png",
}));

async function api(parameters) {
  const url = new URL(endpoint);
  Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers: { "user-agent": "DownloadImages Fandom sync/1.0" } });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return response.json();
}

function parseSkins(lua) {
  const skins = [];
  let hero, section, entry;
  for (const line of lua.split("\n")) {
    let match;
    if ((match = line.match(/^    \["([^"]+)"\] = \{$/))) [hero, section, entry] = [match[1], null, null];
    else if ((match = line.match(/^        \["(skins|painted-skins|sacred-statue)"\] = \{$/))) [section, entry] = [match[1], null];
    else if ((match = line.match(/^            \["([^"]+)"\] = \{$/))) entry = { key: match[1] };
    else if (entry && (match = line.match(/^                \["id"\] = "([^"]+)"/))) entry.id = match[1];
    else if (entry && (match = line.match(/^                \["name"\] = "([^"]+)"/))) {
      entry.name = match[1];
      if (hero && section === "skins" && entry.id) skins.push({ hero, ...entry });
      entry = null;
    }
  }
  return skins;
}

const parsed = await api({ action: "parse", page: "Module:Skin/data", prop: "wikitext", format: "json" });
const fandomSkins = parseSkins(parsed.parse.wikitext["*"]);
const files = (await readdir(portraits)).filter((file) => file.endsWith(".png"));
const filesByKey = new Map(files.map((file) => [normalize(file.slice(0, -4)), file]));
const filesByLooseKey = new Map(files.map((file) => [normalizeLoose(file.slice(0, -4)), file]));
const seenHeroes = new Set();
const matches = [];
const unmatched = [];

for (const skin of fandomSkins) {
  const isDefault = !seenHeroes.has(skin.hero);
  seenHeroes.add(skin.hero);
  const heroKey = normalize(skin.hero);
  const skinKey = normalize(skin.name);
  const skinWithoutRepeatedHero = skinKey.replace(heroKey, "");
  const keys = [normalize(`${skin.hero}-${skin.name}`), `${heroKey}${skinWithoutRepeatedHero}`];
  if (isDefault) keys.push(normalize(`${skin.hero}-Default`));
  const filename = filenameAliases.get(`${skin.hero}|${skin.name}`)
    ?? keys.map((key) => filesByKey.get(key)).find(Boolean)
    ?? filesByLooseKey.get(normalizeLoose(`${skin.hero}-${skin.name}`));
  if (filename) matches.push({ ...skin, filename });
  else unmatched.push({ hero: skin.hero, skin: skin.name, id: skin.id });
}

const imageInfo = new Map();
for (let offset = 0; offset < matches.length; offset += 50) {
  const batch = matches.slice(offset, offset + 50);
  const result = await api({
    action: "query",
    titles: batch.map(({ id }) => `File:Hero${id}-portrait.png`).join("|"),
    prop: "imageinfo",
    iiprop: "url|size|mime",
    format: "json",
  });
  for (const page of Object.values(result.query.pages)) {
    if (page.imageinfo?.[0]) imageInfo.set(page.title, page.imageinfo[0]);
  }
}

let replaced = 0;
const unavailable = [];
for (const match of matches) {
  const info = imageInfo.get(`File:Hero${match.id}-portrait.png`);
  if (!info?.url || info.mime !== "image/png") {
    unavailable.push({ hero: match.hero, skin: match.name, id: match.id, filename: match.filename });
    continue;
  }
  if (!dryRun) {
    const originalUrl = new URL(info.url);
    originalUrl.searchParams.set("format", "original");
    const response = await fetch(originalUrl, { headers: { "user-agent": "DownloadImages Fandom sync/1.0" } });
    if (!response.ok) throw new Error(`${response.status}: ${info.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`Expected PNG bytes: ${originalUrl}`);
    }
    await writeFile(path.join(portraits, match.filename), bytes);
  }
  replaced += 1;
}

console.log(JSON.stringify({ dryRun, localPortraits: files.length, fandomSkins: fandomSkins.length, matched: matches.length, replaced, unmatched, unavailable }, null, 2));
