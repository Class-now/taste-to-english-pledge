import { describe, expect, it } from "vitest";
import js from "../public/app.js?raw";
import html from "../public/index.html?raw";

describe("frontend static checks", () => {
  it("never writes HTML strings into the DOM", () => {
    for (const src of [js, html]) {
      expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    }
  });

  it("loads no external scripts", () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual([`<script type="module" src="/app.js">`, `<script type="module" src="/pledge.js">`]);
    expect(js).not.toMatch(/\bimport\s.*from\s+["']https?:/);
  });

  it("every element id used by app.js exists in index.html", () => {
    const ids = [...js.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(html, `missing #${id}`).toContain(`id="${id}"`);
  });

  it("calls the documented API endpoints", () => {
    expect(js).toContain('fetch("/api/health"');
    expect(js).toContain('fetch("/api/plan"');
  });

  it("has the product title, favicon and live regions", () => {
    expect(html).toContain("<title>Taste-to-English — learn English through what you already love</title>");
    expect(html.match(/aria-live="polite"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('rel="icon" href="data:image/svg+xml');
  });
});
