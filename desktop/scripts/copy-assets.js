/**
 * CibilBazaar Dialer — copies static renderer assets (HTML/CSS) that the
 * TypeScript compiler doesn't touch into dist/renderer, so the packaged
 * app finds them next to the compiled JS.
 */
const fs = require("fs");
const path = require("path");

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

const root = path.join(__dirname, "..");
const targets = [
  { from: "src/renderer/index.html", to: "dist/renderer/index.html" },
  { from: "src/renderer/styles", to: "dist/renderer/styles" },
];

for (const t of targets) {
  const from = path.join(root, t.from);
  const to = path.join(root, t.to);
  if (!fs.existsSync(from)) {
    console.warn(`copy-assets: skipped missing ${t.from}`);
    continue;
  }
  copyRecursive(from, to);
  console.log(`copy-assets: ${t.from} -> ${t.to}`);
}
