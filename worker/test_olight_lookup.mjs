import { lookupOlightCatalog, objectHasForbiddenMoney, catalogFieldsLookLikeMoney, OLIGHT_ROW_COUNT } from "./olight_catalog.js";
import { readFileSync } from "node:fs";

const expected = [
  { upc: "6977261694344", part: "I3EHG", brand: "Olight", name: "i3E EOS Keychain Flashlight - Halloween Ghost", msrp: 12.99 },
  { upc: "6977261692661", part: "SPHERECSSKY", brand: "Olight", name: "Sphere C Light Ball StellarSky", msrp: 23.98 },
  { upc: "6977370477036", part: "U1SS", brand: "Oknife", name: "Otacle U1 Folding Utility Knife - Stars & Stripes", msrp: 24.99 },
  { upc: "6977370477067", part: "U1GM", brand: "Oknife", name: "Otacle U1 Folding Utility Knife - Green Micarta", msrp: 24.99 },
  { upc: "6977370470709", part: "U1 ULTRA ZOMBIE GREEN", brand: "Oknife", name: "U1ULTRAZG Otacle U1 Ceramic Ultra Button Lock Knife Zombie Green Aluminum Handle", msrp: 54.99 },
  { upc: "6977261691985", part: "OCLIPULTRAOAL", brand: "Olight", name: "Oclip Ultra Clip-On EDC Light with Flood, Spot, and UV Modes - Olive Green", msrp: 49.99 },  { upc: "6977261697437", part: "SPHERECPINK", brand: "Olight", name: "Sphere C Pink Ambient Light with App Control for Charity Sale", msrp: 17.99 },
  { upc: "6972378120328", part: "I3TDT1", brand: "Olight", name: "i3T EOS Small Flashlight - Desert Tan", msrp: 17.99 },
  { upc: "6977261697734", part: "I3T 2 EOS MOKUME CAMOCARBON", brand: "Olight", name: "i3T 2 EOS Mokume CamoCarbon", msrp: "" },
  { upc: "6977261697505", part: "ARKPROSSEV2", brand: "Olight", name: "ArkPro Series – Flat Unibody EDC Flashlight with Multi-Light Sources - ArkPro / Stars & Stripes Edition", msrp: 99.99 },
];

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("PASS", name);
  } else {
    failed += 1;
    console.log("FAIL", name, detail || "");
  }
}

check("catalog has 749 rows", OLIGHT_ROW_COUNT === 749, OLIGHT_ROW_COUNT);

for (const exp of expected) {
  const r = lookupOlightCatalog(exp.upc);
  const label = `UPC ${exp.upc}`;
  check(`${label} found`, !!r && r.found === true, r);
  if (!r) continue;
  check(`${label} no forbidden money fields`, !objectHasForbiddenMoney(r), JSON.stringify(Object.keys(r)));
  check(`${label} brand`, r.brand === exp.brand, r.brand);
  check(`${label} part number`, r.model === exp.part, r.model);
  check(`${label} name`, r.description === exp.name, r.description);
  check(`${label} msrp`, r.msrp === exp.msrp, r.msrp);
  check(`${label} titleIsName`, r.titleIsName === true);
  check(`${label} no price key`, !("price" in r) && !("cost" in r));
}

const byPart = lookupOlightCatalog("I3EHG");
check("part number I3EHG found", !!byPart && byPart.found && byPart.upc === "6977261694344" && byPart.msrp === 12.99, byPart);
check("part number I3EHG no cost/price", byPart && !objectHasForbiddenMoney(byPart) && !("price" in byPart) && !("cost" in byPart));

const byMokume = lookupOlightCatalog("I3T 2 EOS MOKUME CAMOCARBON");
check("part number Mokume found", !!byMokume && byMokume.found && byMokume.upc === "6977261697734" && byMokume.msrp === "", byMokume);
check("Mokume msrp left blank", byMokume && byMokume.msrp === "");
check("Mokume no cost/price", byMokume && !objectHasForbiddenMoney(byMokume) && !("price" in byMokume) && !("cost" in byMokume));

const unknown = lookupOlightCatalog("0009998887776");
check("unknown UPC not found", unknown === null, unknown);
const unknownPart = lookupOlightCatalog("NOSUCHSKU");
check("unknown part not found", unknownPart === null, unknownPart);

check("saveCatalog allows msrp", catalogFieldsLookLikeMoney(["upc", "model", "msrp", "title"]) === false);
check("saveCatalog rejects price", catalogFieldsLookLikeMoney(["upc", "price"]) === true);
check("saveCatalog rejects cost", catalogFieldsLookLikeMoney(["upc", "cost"]) === true);

// Bundled source itself must not contain cost/price keys (msrp is ok)
const src = readFileSync(new URL("./olight_catalog.js", import.meta.url), "utf8");
const headerEnd = src.indexOf("const ROWS = ");
const jsonStart = src.indexOf("[", headerEnd);
const jsonEnd = src.indexOf("];\n", jsonStart) + 1;
const rows = JSON.parse(src.slice(jsonStart, jsonEnd));
const badCols = new Set();
for (const row of rows) {
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() !== "msrp" && /cost|price|imap/i.test(key)) badCols.add(key);
  }
}
check("bundled rows have no cost/price columns", badCols.size === 0, [...badCols].join(","));

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll lookup tests passed");
