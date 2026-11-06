/**
 * Renders the two pictures the simulated camera "takes": a tamper-evident seal across the
 * closing seam of a carton, intact and broken. They stand in for real photos until a camera is
 * connected; drop real photos over the PNGs in ../assets to demo with those instead.
 *
 *   pnpm --filter @pinky/device assets:seals
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../assets');

const carton = `
  <defs>
    <linearGradient id="board" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#c79a63"/><stop offset="1" stop-color="#a97c48"/>
    </linearGradient>
    <pattern id="flute" width="14" height="14" patternUnits="userSpaceOnUse">
      <rect width="14" height="14" fill="none"/><line x1="0" y1="0" x2="0" y2="14" stroke="#9b7140" stroke-width="1" opacity="0.35"/>
    </pattern>
    <pattern id="void" width="74" height="30" patternUnits="userSpaceOnUse" patternTransform="rotate(-18)">
      <text x="2" y="21" font-family="Helvetica, Arial, sans-serif" font-size="19" font-weight="700" fill="#8f1d1d" opacity="0.75">VOID</text>
    </pattern>
  </defs>
  <rect width="640" height="480" fill="#4b4f55"/>
  <rect x="40" y="36" width="560" height="408" rx="6" fill="url(#board)"/>
  <rect x="40" y="36" width="560" height="408" rx="6" fill="url(#flute)"/>
  <!-- the closing seam between the two flaps -->
  <rect x="40" y="236" width="560" height="8" fill="#3a2a18"/>
  <line x1="40" y1="236" x2="600" y2="236" stroke="#e0bd8c" stroke-width="1.5" opacity="0.6"/>
  <text x="62" y="74" font-family="Helvetica, Arial, sans-serif" font-size="20" font-weight="700" fill="#5b4126">LOT-42  ·  KEEP 2–8 °C</text>
  <text x="62" y="424" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#5b4126">Cold-chain pharma · 100 units</text>
`;

const labelText = `
  <text x="320" y="214" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="25" font-weight="700" fill="#ffffff">SECURITY SEAL</text>
  <text x="320" y="286" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="17" font-weight="700" fill="#ffffff">DO NOT BREAK · No. 000042</text>
`;

const intact = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
  ${carton}
  <!-- one unbroken label straddling the seam -->
  <rect x="150" y="170" width="340" height="140" rx="5" fill="#c62828" stroke="#ffffff" stroke-width="4"/>
  <rect x="160" y="180" width="320" height="120" rx="3" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-dasharray="6 5"/>
  ${labelText}
</svg>`;

const broken = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
  ${carton}
  <!-- the flaps have been opened: a dark gap where the seam was -->
  <polygon points="40,226 600,214 600,262 40,252" fill="#17110a"/>
  <!-- adhesive residue left where the label was lifted -->
  <rect x="150" y="150" width="340" height="60" fill="#f3e9da"/>
  <rect x="150" y="150" width="340" height="60" fill="url(#void)"/>
  <!-- upper half of the label, torn along the seam and peeled back -->
  <polygon points="150,150 490,150 490,196 462,214 436,200 408,218 380,203 350,221 322,205 292,220 264,204 236,219 208,205 180,217 150,206"
           fill="#c62828" stroke="#ffffff" stroke-width="4" transform="rotate(-7 320 180) translate(-10 -34)"/>
  <!-- lower half, torn edge facing up, shifted off the seam -->
  <polygon points="150,274 180,262 208,276 236,263 264,278 292,264 322,279 350,265 380,280 408,266 436,279 462,265 490,276 490,330 150,330"
           fill="#c62828" stroke="#ffffff" stroke-width="4" transform="rotate(5 320 300) translate(14 10)"/>
  <text x="330" y="318" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="17" font-weight="700" fill="#ffffff" transform="rotate(5 320 300) translate(14 10)">DO NOT BREAK · No. 000042</text>
</svg>`;

mkdirSync(OUT, { recursive: true });
for (const [name, svg] of [
  ['seal-intact', intact],
  ['seal-broken', broken],
] as const) {
  const png = new Resvg(svg, { font: { loadSystemFonts: true }, background: '#4b4f55' }).render().asPng();
  writeFileSync(resolve(OUT, `${name}.png`), png);
  console.log(`${name}.png  ${png.length} bytes`);
}
