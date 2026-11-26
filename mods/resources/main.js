// Resources: memory and CPU by space › tab › terminal › process, drilling down to single processes.
// One local shell call (SAMPLE_SCRIPT) every few seconds, and only while shown. Terminal PIDs come from
// `hc get` once per terminal (a live terminal's PID never changes). Icons and tiles follow Herdr's program table.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, exec, focused, hc, layout, panes, props, run, spaces, terminals, theme } from "herdr";
import { SAMPLE_SCRIPT, age, ageLevel, allIds, buildTree, bytes, cpuOf, filterTree, jumpOf, parseSample, sortTree, ticksOf, visibleRows, withAges } from "./res.js";

const EVERY_MS = 3000;
const INDENT = 14;
const SORT_KEYS = [["mem", "Memory"], ["cpu", "CPU"], ["age", "Age"], ["name", "Name"]];
const GROUPS = [["sessions", "Sessions"], ["services", "Services"], ["detached", "Detached"]];
const BIG = 100 * 1024 ** 2;
const ICON_CHECK = "cd icons && ls *.svg && echo '<<colour>>' && grep -lE 'fill=\"#|fill:#|stop-color|fill=\"url' *.svg";

/** Whether a layout block of this mod is on screen: no hidden ancestor, and each stack shows its branch. */
function blockShown(node, path = []) {
  if (!node || node.hidden) return false;
  if (node.content?.mod === "resources") return path.every(({ parent, child }) => parent.type !== "stack" || parent.active === child.id);
  return (node.children ?? []).some((c) => blockShown(c, [...path, { parent: node, child: c }]));
}

/** Whether this mod is being looked at: its pane on the focused tab, else a visible layout block (the side panel). */
function shown() {
  const me = panes().find((p) => p.pane === props()?.pane);
  if (me) return me.tab === focused()?.tab;
  // An overlay window is only alive while it's up; a layout block (the side panel) can be hidden.
  return Boolean(props()?.overlay) || blockShown(layout());
}

export default class Resources extends View {
  init(_props, cx) {
    this.pids = new Map();        // address → pid
    this.icons = new Set();       // icons/<key>.svg that exist
    this.coloured = new Set();    // of those, the full-colour ones (drawn as pictures, not tinted)
    this.expanded = new Set();
    this.firstTree = true;
    this.sample = null;
    this.prevTicks = null;
    this.prevAt = 0;
    this.busy = false;
    this.error = null;
    // Sort and filters are remembered per viewer; the search box starts empty.
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem("view") ?? "{}"); } catch { /* no storage: defaults */ }
    this.sort = SORT_KEYS.some(([k]) => k === saved.sort) ? saved.sort : "mem";
    this.reverse = Boolean(saved.reverse);
    this.groups = new Set(Array.isArray(saved.groups) ? saved.groups : GROUPS.map(([k]) => k));
    this.big = Boolean(saved.big);
    this.search = InputState.new({ placeholder: "Search name, pid, command…" });
    this.search.on("change", (_e, cx) => cx.notify());
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", ICON_CHECK], { cwd: appHome() });
        const [names = "", colour = ""] = r.stdout.split("<<colour>>");
        const keys = (s) => s.split("\n").map((l) => l.trim().replace(/\.svg$/, "")).filter(Boolean);
        this.icons = new Set(keys(names));
        this.coloured = new Set(keys(colour));
      } catch { /* no icons folder: tiles show without glyphs */ }
      cx.notify();
    });
    this.tick(cx);
    cx.timer.every(EVERY_MS, (cx) => this.tick(cx));
  }

  tick(cx) {
    if (this.busy || !shown()) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const live = terminals().filter((t) => t.state === "live" && !t.address.includes("/"));
        const missing = live.filter((t) => !t.pid && !this.pids.has(t.address));
        await Promise.all(missing.map(async (t) => {
          try {
            const pid = JSON.parse((await hc(["get", t.address, "--json"])).stdout)?.pid;
            if (pid) this.pids.set(t.address, pid);
          } catch { /* gone between ls and get: next tick */ }
        }));
        const r = await exec("sh", ["-c", SAMPLE_SCRIPT], { timeout: 10000 });
        const now = Date.now(), sample = parseSample(r.stdout);
        this.cpu = cpuOf(this.prevTicks, sample.procs, now - this.prevAt, sample.sys.hz);
        this.prevTicks = ticksOf(sample.procs);
        this.prevAt = now;
        this.sample = sample;
        this.seq = (this.seq ?? 0) + 1;
        for (const [address, pid] of this.pids) if (!sample.procs.has(pid)) this.pids.delete(address);
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = false;
      cx.notify();
    });
  }

  remember() {
    try { localStorage.setItem("view", JSON.stringify({ sort: this.sort, reverse: this.reverse, groups: [...this.groups], big: this.big })); } catch { /* not remembered */ }
  }

  toggle(id, cx) {
    if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
    cx.notify();
  }

  // A terminal's tile comes from the app's table, as the terminals bar draws it; a process's from its icon and colour.
  tile(n, t) {
    const box = (bg) => div().flex_none().size(18).rounded(5).border(1).border_color("#ffffff14").bg(bg).flex().items_center().justify_center();
    if (n.kind === "term") {
      const g = n.program;
      return box(g?.tile ?? t.raised).when(Boolean(g?.icon), (el) =>
        el.child(g.tint ? svg(g.icon).size(11).text_color(g.color ?? "#ffffff") : image(g.icon).size(11)));
    }
    if (n.kind === "space" || n.kind === "tab") {
      return box(t.raised).child(svg(n.kind === "space" ? "mods/resources/space.svg" : "mods/resources/tab.svg").size(11).text_color(t.muted));
    }
    const key = n.type === "mcp" ? "mcp" : n.key;
    const icon = key === "mcp" ? "mods/resources/mcp.svg" : this.icons.has(key) ? `icons/${key}.svg` : "icons/program.svg";
    return box(n.color).child(this.coloured.has(key) ? image(icon).size(11) : svg(icon).size(11).text_color("#ffffff"));
  }

  // The jump button: an arrow for something on screen in a pane (or a space/tab), an eye to peek at a hidden terminal.
  jump(n, t, paneTerms) {
    const j = jumpOf(n, paneTerms);
    const slot = div().w(20).h(20).flex_none();
    if (!j) return slot;
    const tip = j.kind === "peek" ? "Peek at its terminal" : n.kind === "space" ? "Show this space" : n.kind === "tab" ? "Show this tab" : "Go to its pane";
    return slot.id(`j-${n.id}`).flex().items_center().justify_center().rounded(5).text_color(t.dim)
      .hover((s) => s.bg(t.selected).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); for (const [name, args] of j.run) run(name, args); })
      .child(svg(j.kind === "peek" ? "mods/resources/peek.svg" : "mods/resources/go.svg").size(12));
  }

  row({ node: n, depth, open, leaf }, t, memMax, paneTerms) {
    const cpuColor = n.cpu >= 80 ? t.blocked : n.cpu >= 20 ? t.working : t.muted;
    const lvl = ageLevel(n.ageS ?? 0);
    const ageColor = lvl === "old" ? t.blocked : lvl === "day" ? t.working : t.muted;
    const share = memMax ? Math.max(0.01, n.mem / memMax) : 0;
    const strong = n.kind === "space" || n.kind === "term";
    return h_flex().id(`r-${n.id}`).flex_none().h(n.sub ? 34 : 26).pl(6 + depth * INDENT).pr(8).gap(6).items_center().rounded(5)
      .hover((s) => s.bg(t.hover))
      .when(Boolean(n.args), (el) => el.tooltip(n.args))
      .on_click((e, cx) => {
        // Double-click a terminal to go to it; a single click opens or closes any row.
        const j = e.click_count === 2 && n.kind === "term" ? jumpOf(n, paneTerms) : null;
        if (j) for (const [name, args] of j.run) run(name, args);
        else if (!leaf) this.toggle(n.id, cx);
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        cx.write_to_clipboard(n.pid ? String(n.pid) : n.address ? `hc read ${n.address}` : n.label);
      })
      .child(div().flex_none().size(12).when(!leaf, (el) => el.child(svg(open ? "mods/files/chevron-down.svg" : "mods/files/chevron-right.svg").size(12).text_color(t.dim))))
      .child(this.tile(n, t))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(5).items_center().min_w(0)
          .child(div().truncate().text_size(12).text_color(t.foreground).when(strong, (el) => el.font_semibold()).child(n.label))
          .when(Boolean(n.status) && n.status !== "idle", (el) => el.child(n.status === "working"
            ? svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().text_color(t.working).spin(900)
            : div().size(6).rounded(3).flex_none().bg(t[n.status] ?? t.dim))))
        .when(Boolean(n.sub), (el) => el.child(div().truncate().text_size(10).text_color(t.dim).child(n.sub))))
      .child(this.jump(n, t, paneTerms))
      .child(div().relative().w(46).h(4).flex_none().rounded(2).bg(t.raised)
        .child(div().absolute().top(0).left(0).h(4).rounded(2).bg(n.color ?? t.working).w(`${Math.round(share * 100)}%`).transition("width", 300)))
      .child(div().w(58).flex_none().text_size(11).text_color(t.foreground).text_right().child(bytes(n.mem)))
      .child(div().w(42).flex_none().text_size(11).text_color(cpuColor).text_right().child(`${Math.round(n.cpu)}%`))
      .child(div().w(36).flex_none().text_size(11).text_color(ageColor).text_right().child(n.ageS ? age(n.ageS) : ""));
  }

  render(cx) {
    const t = theme();
    const list = terminals().map((x) => ({ ...x, pid: x.pid ?? this.pids.get(x.address) }));
    // Building and sorting the tree is the costly part under QuickJS, so it happens once per sample (3 s) and
    // again only when the view settings change, not on every redraw (terminals() changes redraw often).
    if (this.sample && this.builtSeq !== this.seq) {
      this.full = withAges(buildTree(list, this.sample.procs, this.cpu, spaces()));
      this.builtSeq = this.seq;
      this.viewKey = null;
    }
    const full = this.full ?? [];
    if (this.firstTree && full.length) {
      this.firstTree = false;
      for (const s of full) this.expanded.add(s.id); // spaces open, the rest closed
    }
    const query = this.search.value().trim();
    const key = JSON.stringify([this.sort, this.reverse, [...this.groups], this.big, query]);
    if (key !== this.viewKey) {
      const { tree: kept, open } = filterTree(full, { groups: this.groups, minMem: this.big ? BIG : 0, query });
      this.view = { tree: sortTree(kept, this.sort, this.reverse), open };
      this.viewKey = key;
    }
    const { tree, open } = this.view ?? { tree: [], open: new Set() };
    // While searching, the path to every match opens by itself; clearing the search puts back what was open.
    const rows = visibleRows(tree, query ? new Set([...this.expanded, ...open]) : this.expanded);
    const memMax = Math.max(0, ...tree.map((n) => n.mem));
    const paneTerms = new Set(panes().map((p) => p.terminal).filter(Boolean));
    const sessions = full.filter((n) => n.id !== "space:services" && n.id !== "space:detached");
    const sum = sessions.reduce((a, n) => ({ mem: a.mem + n.mem, cpu: a.cpu + n.cpu }), { mem: 0, cpu: 0 });
    const sys = this.sample?.sys;
    const chip = (id, label, on, action) => div().id(id).px(7).h(20).flex().items_center().flex_none().rounded(10).text_size(11)
      .border(1).border_color(on ? t.accent : t.border).bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click(action).child(label);
    // Click a heading to sort by it; click it again to flip the order.
    const heading = (k, label, size) => size(h_flex().id(`h-${k}`).gap(2).items_center().rounded(4).cursor_pointer()
      .text_color(this.sort === k ? t.foreground : t.dim).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => {
        if (this.sort === k) this.reverse = !this.reverse; else { this.sort = k; this.reverse = false; }
        this.remember(); cx.notify();
      })
      .child(label)
      .when(this.sort === k, (el) => el.child(div().text_size(9).child(this.reverse !== (k === "name") ? "▲" : "▼"))));
    const button = (id, label, action) => div().id(id).px(7).h(22).flex().items_center().flex_none().rounded(6).text_size(11.5)
      .text_color(t.muted).bg(t.chrome).hover((s) => s.bg(t.hover)).on_click(action).child(label);
    return v_flex().id("resources").size_full().bg(t.surface).text_color(t.foreground)
      .child(h_flex().flex_none().h(34).px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(13).font_semibold().child("Resources"))
        .child(button("expand", "Expand all", (_e, cx) => { this.expanded = new Set(allIds(tree)); cx.notify(); }))
        .child(button("collapse", "Collapse", (_e, cx) => { this.expanded = new Set(); cx.notify(); })))
      .when(Boolean(sys), (el) => el.child(h_flex().flex_none().px(12).py(6).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.muted).child(`Sessions ${bytes(sum.mem)} · ${Math.round(sum.cpu)}% CPU`))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(`Machine ${bytes(sys.memTotal - sys.memAvail)} of ${bytes(sys.memTotal)} · ${sys.cores} cores`))))
      .child(v_flex().flex_none().px(10).py(6).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center()
          .child(div().id("res-search").flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(6).border(1).border_color(query ? t.accent : t.border).bg(t.raised).cursor_text()
            .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.search.focus(); })
            .child(Input.new(this.search).flex_1().h_full().text_size(12).text_color(t.foreground)))
          .when(Boolean(query), (el) => el.child(button("clear", "Clear", (_e, cx) => { this.search.set_value(""); cx.notify(); }))))
        .child(h_flex().gap(4).items_center().flex_wrap()
          .child(div().text_size(10.5).text_color(t.dim).mr(2).child("Show"))
          .children(GROUPS.map(([k, label]) => chip(`group-${k}`, label, this.groups.has(k), (_e, cx) => {
            if (this.groups.has(k)) this.groups.delete(k); else this.groups.add(k);
            this.remember(); cx.notify();
          })))
          .child(chip("big", "≥ 100 MB", this.big, (_e, cx) => { this.big = !this.big; this.remember(); cx.notify(); }))))
      .when(rows.length > 0, (el) => el.child(h_flex().flex_none().pl(10).pr(14).pt(4).gap(6).items_center().text_size(10).text_color(t.dim)
        .child(heading("name", "Name", (d) => d.flex_1().pl(32)))
        .child(div().w(72).flex_none())
        .child(heading("mem", "Memory", (d) => d.w(58).flex_none().justify_end()))
        .child(heading("cpu", "CPU", (d) => d.w(42).flex_none().justify_end()))
        .child(heading("age", "Age", (d) => d.w(36).flex_none().justify_end()))))
      .child(rows.length
        ? v_flex().id("res-list").flex_1().min_h(0).p(6).gap(1).overflow_y_scrollbar().children(rows.map((r) => this.row(r, t, memMax, paneTerms)))
        : div().flex_1().p(14).text_size(12.5).text_color(t.muted).child(this.error ? `Couldn't read processes: ${this.error}` : !this.sample ? "Reading processes…" : query || this.big || this.groups.size < GROUPS.length ? "Nothing matches." : "No local terminals."))
      .child(div().flex_none().px(12).py(5).border_t(1).border_color(t.border).text_size(10).text_color(t.dim)
        .child("CPU is % of one core. Memory is resident (shared pages count in each process). Age: amber after a day, red after 3. ↗ goes to it, the eye peeks. Right-click copies the PID."));
  }
}
