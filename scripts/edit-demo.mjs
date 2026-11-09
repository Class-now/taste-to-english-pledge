// Turns raw.webm + marks.json from record-demo.mjs into demo.mp4: marked waits are sped up.
// Usage: node scripts/edit-demo.mjs <out-dir>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "demo-out";
const { marks, total } = JSON.parse(readFileSync(join(dir, "marks.json"), "utf8"));
// Keep only outermost spans (an outer "days 2-7" span contains the inner waits).
const spans = [...marks].sort((a, b) => a.start - b.start || b.end - a.end).filter((m, i, arr) => !arr.slice(0, i).some((o) => o.start <= m.start && o.end >= m.end));
const segs = [];
let t = 0;
for (const s of spans) {
  if (s.start > t) segs.push({ a: t, b: s.start, speed: 1 });
  segs.push({ a: s.start, b: s.end, speed: s.speed });
  t = s.end;
}
segs.push({ a: t, b: total, speed: 1 });
const parts = segs.map((s, i) => `[0:v]trim=start=${s.a.toFixed(3)}:end=${s.b.toFixed(3)},setpts=(PTS-STARTPTS)/${s.speed}[v${i}]`);
const filter = `${parts.join(";")};${segs.map((_, i) => `[v${i}]`).join("")}concat=n=${segs.length}:v=1:a=0,fps=30,format=yuv420p[out]`;
const length = segs.reduce((n, s) => n + (s.b - s.a) / s.speed, 0);
console.log("segments", segs.length, "→ length", length.toFixed(1), "s");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(dir, "raw.webm"), "-filter_complex", filter, "-map", "[out]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", join(dir, "demo.mp4")], { stdio: "inherit" });
console.log("wrote", join(dir, "demo.mp4"));
