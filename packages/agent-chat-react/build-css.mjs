// Concatenate the component CSS into a single shipped dist/styles.css.
// tsup compiles the TSX/d.ts; CSS isn't part of that graph (the components
// don't `import "./x.css"` — the host imports "@pwrdrvr/agent-chat-react/styles.css"
// once), so we assemble it here as a post-build step.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "src", "styles");
const outFile = join(here, "dist", "styles.css");

// Order matters only for cascade ties; keep it deterministic + readable.
const parts = [
  "tokens.css",
  "MessageList.css",
  "Composer.css",
  "ChatApprovalModal.css"
];

const banner =
  "/* @pwrdrvr/agent-chat-react — bundled component styles.\n" +
  "   Import once in your app: import \"@pwrdrvr/agent-chat-react/styles.css\";\n" +
  "   Override the design tokens in :root to retheme. */\n\n";

const chunks = [];
for (const part of parts) {
  const css = await readFile(join(srcDir, part), "utf8");
  chunks.push(`/* ===== ${part} ===== */\n${css.trim()}\n`);
}

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, banner + chunks.join("\n"), "utf8");
console.log(`[agent-chat-react] wrote ${outFile}`);
