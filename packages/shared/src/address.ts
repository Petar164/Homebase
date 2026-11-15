// Splits a pasted address block into fields, so a buyer's address can be
// copied from an email or order page in one go:
//
//   Sam Example
//   Voorbeeldstraat 12
//   1234 AB Amsterdam
//   Netherlands
//
// It is a best guess. The form shows the result so it can be corrected, and
// the server validates the fields again.

import type { SaleRegion } from "./types.ts";

export type ParsedAddress = {
  name: string;
  email: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
};

// Country name or code (lower case) -> name to store.
const COUNTRIES: Record<string, string> = {
  nl: "Netherlands", nederland: "Netherlands", netherlands: "Netherlands", "the netherlands": "Netherlands", holland: "Netherlands",
  be: "Belgium", belgie: "Belgium", "belgië": "Belgium", belgium: "Belgium", belgique: "Belgium",
  de: "Germany", germany: "Germany", deutschland: "Germany", duitsland: "Germany",
  fr: "France", france: "France", frankrijk: "France",
  es: "Spain", spain: "Spain", "españa": "Spain", spanje: "Spain",
  it: "Italy", italy: "Italy", italia: "Italy", "italië": "Italy",
  pt: "Portugal", portugal: "Portugal",
  at: "Austria", austria: "Austria", "österreich": "Austria", oostenrijk: "Austria",
  ie: "Ireland", ireland: "Ireland", ierland: "Ireland",
  dk: "Denmark", denmark: "Denmark", danmark: "Denmark", denemarken: "Denmark",
  se: "Sweden", sweden: "Sweden", sverige: "Sweden", zweden: "Sweden",
  fi: "Finland", finland: "Finland", suomi: "Finland",
  pl: "Poland", poland: "Poland", polska: "Poland", polen: "Poland",
  cz: "Czechia", czechia: "Czechia", "czech republic": "Czechia", "tsjechië": "Czechia",
  gr: "Greece", greece: "Greece", griekenland: "Greece",
  hu: "Hungary", hungary: "Hungary", hongarije: "Hungary",
  ro: "Romania", romania: "Romania", "roemenië": "Romania",
  bg: "Bulgaria", bulgaria: "Bulgaria", bulgarije: "Bulgaria",
  hr: "Croatia", croatia: "Croatia", hrvatska: "Croatia", "kroatië": "Croatia",
  si: "Slovenia", slovenia: "Slovenia", "slovenië": "Slovenia",
  sk: "Slovakia", slovakia: "Slovakia", slowakije: "Slovakia",
  lt: "Lithuania", lithuania: "Lithuania", litouwen: "Lithuania",
  lv: "Latvia", latvia: "Latvia", letland: "Latvia",
  ee: "Estonia", estonia: "Estonia", estland: "Estonia",
  lu: "Luxembourg", luxembourg: "Luxembourg", luxemburg: "Luxembourg",
  mt: "Malta", malta: "Malta",
  cy: "Cyprus", cyprus: "Cyprus",
  gb: "United Kingdom", uk: "United Kingdom", "united kingdom": "United Kingdom", england: "United Kingdom", "great britain": "United Kingdom", "verenigd koninkrijk": "United Kingdom",
  us: "United States", usa: "United States", "united states": "United States", "united states of america": "United States", "verenigde staten": "United States",
  ch: "Switzerland", switzerland: "Switzerland", schweiz: "Switzerland", zwitserland: "Switzerland",
  no: "Norway", norway: "Norway", norge: "Norway", noorwegen: "Norway",
  rs: "Serbia", serbia: "Serbia", srbija: "Serbia", "servië": "Serbia",
  ca: "Canada", canada: "Canada",
  au: "Australia", australia: "Australia", "australië": "Australia",
  jp: "Japan", japan: "Japan",
};

const EU = new Set([
  "Belgium", "Germany", "France", "Spain", "Italy", "Portugal", "Austria", "Ireland", "Denmark", "Sweden",
  "Finland", "Poland", "Czechia", "Greece", "Hungary", "Romania", "Bulgaria", "Croatia", "Slovenia",
  "Slovakia", "Lithuania", "Latvia", "Estonia", "Luxembourg", "Malta", "Cyprus",
]);

/** Which VAT region a country falls in. Unknown countries return null: better to ask than to guess. */
export function regionForCountry(country: string): SaleRegion | null {
  const name = COUNTRIES[country.trim().toLowerCase()] ?? country.trim();
  if (!name) return null;
  if (name === "Netherlands") return "NL";
  if (EU.has(name)) return "EU";
  return Object.values(COUNTRIES).includes(name) ? "world" : null;
}

// "1234 AB Amsterdam", "2000 Antwerpen", "10115 Berlin", "75001 Paris"
const POSTAL_THEN_CITY = /^([A-Z]{1,2}-)?(\d{4}\s?[A-Za-z]{2}|\d{4,5}|\d{2}-\d{3}|\d{3}\s\d{2})\s+(.+)$/;
// "London SW1A 1AA"
const CITY_THEN_UK_POSTAL = /^(.+?)\s+([A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2})$/;
// "Springfield, IL 62704"
const CITY_STATE_ZIP = /^(.+?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/;

export function parseAddressBlock(text: string): ParsedAddress {
  const out: ParsedAddress = { name: "", email: "", street: "", postalCode: "", city: "", country: "" };
  let lines = text.split(/\r?\n/).map((l) => l.trim().replace(/,$/, "")).filter(Boolean);
  // A one-line address separated by commas.
  if (lines.length === 1) lines = lines[0].split(",").map((l) => l.trim()).filter(Boolean);

  const rest: string[] = [];
  for (const line of lines) {
    const email = line.match(/[^\s<>()]+@[^\s<>()]+\.[^\s<>()]+/);
    if (email && !out.email) {
      out.email = email[0];
      continue;
    }
    if (/^(\+|00)?[\d\s().-]{8,}$/.test(line)) continue; // a phone number: not stored
    rest.push(line);
  }

  // The country is usually the last line.
  const last = rest[rest.length - 1]?.toLowerCase();
  if (last && COUNTRIES[last]) {
    out.country = COUNTRIES[last];
    rest.pop();
  }

  const remaining: string[] = [];
  for (const line of rest) {
    let m: RegExpMatchArray | null;
    if (!out.postalCode && (m = line.match(POSTAL_THEN_CITY))) {
      out.postalCode = m[2].toUpperCase().replace(/^(\d{4})\s?([A-Z]{2})$/, "$1 $2");
      out.city = m[3];
    } else if (!out.postalCode && (m = line.match(CITY_STATE_ZIP))) {
      out.city = `${m[1]}, ${m[2]}`;
      out.postalCode = m[3];
    } else if (!out.postalCode && (m = line.match(CITY_THEN_UK_POSTAL))) {
      out.city = m[1];
      out.postalCode = m[2].toUpperCase();
    } else remaining.push(line);
  }

  // What is left: the name first, then the street (the line with a house number).
  const streetIndex = remaining.findIndex((l, i) => i > 0 && /\d/.test(l));
  if (streetIndex > -1) out.street = remaining.splice(streetIndex, 1)[0];
  out.name = remaining.shift() ?? "";
  if (!out.street && remaining.length) out.street = remaining.join(", ");

  // A Dutch postal code without a country line means the Netherlands.
  if (!out.country && /^\d{4} [A-Z]{2}$/.test(out.postalCode)) out.country = "Netherlands";
  return out;
}
