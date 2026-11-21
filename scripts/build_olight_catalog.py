#!/usr/bin/env python3
"""Build worker/olight_catalog.js from FORGE olight_master.csv.

Facts only: MSRP is kept; cost and selling-price columns are refused.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

FORBIDDEN = re.compile(r"cost|price|imap", re.I)
ALLOWED = [
    "part_number",
    "brand",
    "title",
    "upc",
    "upc_other_readings",
    "msrp",
    "weight_lb",
    "length_in",
    "width_in",
    "height_in",
    "lithium",
]

FUNCTIONS = r'''
const MONEY_KEY = /^(cost|price|imap|markprice|unitcost|whatnot|startprice)$/i;

export const OLIGHT_ROW_COUNT = ROWS.length;

function partKey(text) {
  return String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function upcKey(text) {
  return String(text || "").trim().replace(/^0+/, "");
}

function moneyMsrp(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : "";
}

function numOrBlank(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : "";
}

function displayName(brand, title) {
  const t = String(title || "").trim();
  const b = String(brand || "").trim();
  if (b && t.toLowerCase().startsWith(b.toLowerCase())) {
    return t.slice(b.length).replace(/^[\s\-–:]+/, "").trim() || t;
  }
  return t;
}

function sanitize(out) {
  const allowed = ["found", "brand", "upc", "model", "description", "msrp", "length", "width", "height", "weight", "lithium", "titleIsName"];
  const clean = {};
  for (const k of allowed) {
    if (k in out) clean[k] = out[k];
  }
  return clean;
}

const byUpc = new Map();
const byPart = new Map();
for (const row of ROWS) {
  const u = upcKey(row.upc);
  if (u && !byUpc.has(u)) byUpc.set(u, row);
  const others = String(row.upc_other_readings || "").split("|");
  for (const raw of others) {
    const k = upcKey(raw);
    if (k && !byUpc.has(k)) byUpc.set(k, row);
  }
  const p = partKey(row.part_number);
  if (p && !byPart.has(p)) byPart.set(p, row);
}

export function lookupOlightCatalog(code) {
  const k = String(code || "").trim();
  if (!k || k.length > 40) return null;
  const row = /^\d+$/.test(k) ? byUpc.get(upcKey(k)) : byPart.get(partKey(k));
  if (!row) return null;
  return sanitize({
    found: true,
    brand: row.brand,
    upc: row.upc,
    model: row.part_number,
    description: displayName(row.brand, row.title),
    msrp: moneyMsrp(row.msrp),
    length: numOrBlank(row.length_in),
    width: numOrBlank(row.width_in),
    height: numOrBlank(row.height_in),
    weight: numOrBlank(row.weight_lb),
    lithium: String(row.lithium || "").toUpperCase() === "YES",
    titleIsName: true,
  });
}

export function objectHasForbiddenMoney(value) {
  const seen = new Set();
  const walk = (v) => {
    if (!v || typeof v !== "object") return false;
    if (seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v)) return v.some(walk);
    for (const [key, val] of Object.entries(v)) {
      if (MONEY_KEY.test(key) || (key.toLowerCase() !== "msrp" && /cost|price|imap/i.test(key))) return true;
      if (walk(val)) return true;
    }
    return false;
  };
  return walk(value);
}

export function catalogFieldsLookLikeMoney(fields) {
  // MSRP is allowed; cost, selling price, IMAP, or a $ field name are not.
  return /cost|price|imap|\$/i.test(JSON.stringify(fields || []));
}
'''

HEADER = """// Auto-generated from FORGE olight_master.csv (Olight / Oknife facts only).
// Includes MSRP (maker or dealer list price). Never includes WRT cost or selling price.
// Rebuild with: python3 scripts/build_olight_catalog.py

"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--csv",
        default=str(
            Path.home()
            / "FORGE/backend/src/forge/infrastructure/adapters/data/olight_master.csv"
        ),
    )
    parser.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parents[1] / "worker" / "olight_catalog.js"),
    )
    args = parser.parse_args()
    src = Path(args.csv)
    dest = Path(args.out)
    with src.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        fields = list(reader.fieldnames or [])
        moneyish = [
            col
            for col in fields
            if FORBIDDEN.search(col) and col.lower() != "msrp" and "msrp_" not in col.lower()
        ]
        if moneyish:
            print(f"Refusing to bundle money columns: {moneyish}", file=sys.stderr)
            return 1
        missing = [col for col in ALLOWED if col not in fields]
        if missing:
            print(f"CSV missing expected columns: {missing}", file=sys.stderr)
            return 1
        rows = []
        for raw in reader:
            item = {key: (raw.get(key) or "").strip() for key in ALLOWED}
            if not item["part_number"] and not item["upc"]:
                continue
            if not item.get("upc_other_readings"):
                item.pop("upc_other_readings", None)
            rows.append(item)
    dest.write_text(
        HEADER
        + "const ROWS = "
        + json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
        + FUNCTIONS,
        encoding="utf-8",
    )
    print(f"wrote {dest} rows={len(rows)} bytes={dest.stat().st_size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
