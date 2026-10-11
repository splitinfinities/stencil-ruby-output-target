// Browser check for runtime/stencil-bridge.ts, standalone and with Herb's real runtime.
// Run from a scratch dir holding a bundle of browser-entry.ts:
//   cp ../runtime/stencil-bridge.ts <generated>/app/javascript/my/elements/manifest.ts <dir>/
//   cp browser-entry.ts <dir>/entry.ts && esbuild <dir>/entry.ts --bundle --format=esm --outfile=<dir>/bundle.js
//   cp browser.mjs <dir>/ && node <dir>/browser.mjs     (needs playwright + @herb-tools/client)
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const bundle = readFileSync(new URL("./bundle.js", import.meta.url), "utf8");

const browser = await chromium.launch();

const results = [];

const check = (name, ok, extra = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);

async function page(body) {
  const p = await browser.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.setContent(`<!doctype html><body>${body}</body>`);
  await p.addScriptTag({ content: bundle, type: "module" });
  await p.waitForFunction(() => window.harness);

  return { p, errors };
}

// Markup exactly as the generated ViewComponents render it (see render smoke test).
const markup = `
  <my-input id="i" value="ruby" name="q" data-stencil-set="update-&gt;query" data-stencil-state="update-&gt;draft"></my-input>
  <my-rollup id="r" data-stencil-props="{&quot;options&quot;:{&quot;a&quot;:[1,&quot;\\u003cb\\u003e&quot;]},&quot;notAllowed&quot;:1}"></my-rollup>`;

{ // Standalone (plain Rails / Turbo)
  const { p, errors } = await page(markup);

  const r = await p.evaluate(async () => {
    const binds = [];
    document.addEventListener("stencil:bind", (e) => binds.push(e.detail));
    window.harness.standalone();
    const rollup = document.getElementById("r");
    const first = JSON.stringify(rollup.options), leaked = "notAllowed" in rollup;
    document.getElementById("i").type("rails");
    rollup.setAttribute("data-stencil-props", JSON.stringify({ options: { b: 2 } }));
    const el = document.createElement("my-input");
    el.setAttribute("data-stencil-set", "update->late");
    document.body.append(el);
    await new Promise((r) => setTimeout(r, 20));
    el.type("added later");
    el.remove(); await new Promise((r) => setTimeout(r, 20));
    el.type("after removal");

    return { first, leaked, second: JSON.stringify(rollup.options), binds };
  });

  check("standalone: JSON props assigned as properties", r.first === '{"a":[1,"<b>"]}', r.first);
  check("standalone: props not in the manifest are ignored", r.leaked === false);
  check("standalone: re-applies when the attribute changes", r.second === '{"b":2}', r.second);
  check("standalone: model value dispatched as stencil:bind", JSON.stringify(r.binds.slice(0, 2)) === JSON.stringify([{ state: "query", value: "rails", scope: "server" }, { state: "draft", value: "rails", scope: "client" }]), JSON.stringify(r.binds));
  check("standalone: wires elements added later, unwires removed ones", r.binds.length === 3 && r.binds[2].value === "added later", `binds=${r.binds.length}`);
  check("standalone: no page errors", errors.length === 0, errors.join("; "));
  await p.close();
}

{ // With Herb's real runtime (ReActionView's client)
  const { p, errors } = await page(markup);

  const r = await p.evaluate(async () => {
    const h = window.harness.herb();
    await new Promise((r) => setTimeout(r, 30));
    const rollup = document.getElementById("r");
    const props = JSON.stringify(rollup.options);
    document.getElementById("i").type("hotwire");
    await new Promise((r) => setTimeout(r, 200));
    rollup.setAttribute("data-stencil-props", JSON.stringify({ options: { c: 3 } }));
    await new Promise((r) => setTimeout(r, 30));

    return { props, after: JSON.stringify(rollup.options), requests: JSON.parse(JSON.stringify(h.requests)), draft: h.runtime.state.getState?.("draft") ?? null };
  });

  check("herb: data-stencil-props behavior assigns properties on connect", r.props === '{"a":[1,"<b>"]}', r.props);
  check("herb: behavior valueChanged re-applies props", r.after === '{"c":3}', r.after);
  const sent = JSON.stringify(r.requests);
  check("herb: update event reaches state.set → transport", sent.includes("hotwire") && sent.includes("query"), sent.slice(0, 300));
  check("herb: no page errors", errors.length === 0, errors.join("; "));
  results.push(`INFO client state 'draft' after write (undeclared, expected null): ${JSON.stringify(r.draft)}`);
  await p.close();
}

await browser.close();

console.log(results.join("\n"));
