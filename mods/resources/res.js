// What the Resources tree shows, with no Herdr or GPUI in it, so tests can run it.
// shortcut: Linux only (/proc), local terminals only; remote machines need exec({ on }) per machine.

/** The one shell command a refresh runs: every process's stat line, then pid + full command line, then memory and cores. */
export const SAMPLE_SCRIPT =
  "cat /proc/[0-9]*/stat 2>/dev/null; echo '<<cg>>'; grep -H '' /proc/[0-9]*/cgroup 2>/dev/null; echo '<<ps>>'; ps -eo pid=,uid=,args=; echo '<<sys>>'; " +
  "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; nproc; getconf CLK_TCK; getconf PAGESIZE; id -u; cat /proc/uptime";

/** Parses SAMPLE_SCRIPT output into { procs: Map<pid, proc>, sys: { memTotal, memAvail, cores } }. */
export function parseSample(text) {
  // Markers on a line of their own: the sampling shell's own command line (in the ps list) holds them too.
  const [procPart = "", rest = ""] = text.split(/^<<ps>>$/m);
  const [statPart = "", cgPart = ""] = procPart.split(/^<<cg>>$/m);
  // cgroup v2: "/proc/<pid>/cgroup:0::/user.slice/.../<unit>"; the last path part names the systemd unit.
  const units = new Map();
  for (const line of cgPart.split("\n")) {
    const m = /^\/proc\/(\d+)\/cgroup:0::.*\/([^/]+)$/.exec(line);
    if (m) units.set(Number(m[1]), m[2]);
  }
  const [psPart = "", sysPart = ""] = rest.split(/^<<sys>>$/m);
  const sysLines = sysPart.trim().split("\n");
  const kb = (name) => Number(/(\d+)/.exec(sysLines.find((l) => l.startsWith(name)) ?? "")?.[1] ?? 0) * 1024;
  const nums = sysLines.filter((l) => /^\d+$/.test(l.trim())).map(Number);
  const [cores = 1, hz = 100, page = 4096, uid = -1] = nums;
  const uptime = Number(/^(\d+\.\d+) /m.exec(sysPart)?.[1] ?? 0);
  const args = new Map(), uids = new Map();
  for (const line of psPart.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) { args.set(Number(m[1]), m[3]); uids.set(Number(m[1]), Number(m[2])); }
  }
  const procs = new Map();
  for (const line of statPart.split("\n")) {
    // comm can hold spaces and brackets, so split around the last ")".
    const open = line.indexOf("("), close = line.lastIndexOf(")");
    if (open < 0 || close < open) continue;
    const pid = Number(line.slice(0, open));
    const f = line.slice(close + 2).split(" ");
    if (!pid || f.length < 22) continue;
    procs.set(pid, {
      pid,
      comm: line.slice(open + 1, close),
      ppid: Number(f[1]),
      ticks: Number(f[11]) + Number(f[12]),
      threads: Number(f[17]),
      ageS: uptime ? Math.max(0, uptime - Number(f[19]) / hz) : 0,
      mine: uids.get(pid) === uid,
      unit: units.get(pid) ?? "",
      rss: Number(f[21]) * page,
      args: args.get(pid) ?? "",
    });
  }
  return { procs, sys: { memTotal: kb("MemTotal"), memAvail: kb("MemAvailable"), cores, hz, uid } };
}

/** Live CPU % of one core per pid, from two samples' tick counts. A pid not in `prev` (new, or first look) gets 0. */
export function cpuOf(prev, procs, elapsedMs, hz = 100) {
  const out = new Map();
  for (const [pid, p] of procs) {
    const before = prev?.get(pid);
    out.set(pid, before !== undefined && elapsedMs > 0 ? Math.max(0, ((p.ticks - before) / hz) * (1000 / elapsedMs) * 100) : 0);
  }
  return out;
}

export const ticksOf = (procs) => new Map([...procs].map(([pid, p]) => [pid, p.ticks]));

const INTERPRETERS = new Set(["node", "bun", "bunx", "deno", "npm", "npx", "pnpm", "python", "python3", "uv", "uvx", "ruby", "perl", "java", "sh", "bash", "zsh"]);
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "nu", "pwsh"]);

/** What a process is: `key` picks the icon and colour, `type` groups siblings, `label` is for people. */
export function kindOf(comm, args = "") {
  // Thread-named and "npm exec x" processes report odd comms; the program is what matters.
  let key = comm.replace(/-MainThread$/, "").split(/[\s/:]/)[0].toLowerCase() || comm;
  if (/^python3(\.\d+)?$/.test(key)) key = "python";
  const words = args.split(/\s+/).filter(Boolean);
  const exe = (words[0] ?? "").split("/").pop() ?? "";
  if (key === "node" || key === "bun") key = exe === "bun" || exe === "node" ? exe : key;
  if (key === "claude" || exe === "claude") return { key: "claude", type: "claude", label: "Claude Code" };
  if (key === "codex" || exe === "codex") return { key: "codex", type: "codex", label: "Codex" };
  if (SHELLS.has(key)) {
    if (words.slice(1).some((w) => /^-[a-z]*c$/.test(w))) return { key: "shell", type: "shell", label: `${key} -c` };
    if (!words.slice(1).some((w) => !w.startsWith("-"))) return { key: "shell", type: "shell", label: key };
  }
  let label = key;
  if (INTERPRETERS.has(key) || INTERPRETERS.has(exe)) {
    // node .../node_modules/@scope/pkg/dist/x.js → @scope/pkg; bun run x.ts → x.ts.
    const script = words.slice(1).find((w) => !w.startsWith("-") && !/^(run|exec|x|-c)$/.test(w)) ?? "";
    const pkg = /node_modules\/(?:\.bin\/)?((?:@[^/]+\/)?[^/]+)/.exec(script)?.[1];
    const name = pkg ?? script.split("/").filter((s) => s && !/^(\.|dist$|build$|bin$|src$|index\.m?js$|cli\.m?js$)/.test(s)).pop() ?? "";
    if (name) label = `${key} · ${name}`;
  }
  if (/\bmcp\b|mcp-server|-mcp\b|mcp\.m?[jt]s/i.test(args)) return { key, type: "mcp", label: `MCP · ${label.replace(/^[^·]+· /, "")}` };
  if (/tsserver|typescript-language-server/.test(args)) return { key: "tsc", type: "tsserver", label: "TypeScript server" };
  return { key, type: key, label };
}

/** A stable colour for anything without a brand colour, as Herdr gives unlisted programs one. */
export function hashColor(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360, s = 0.45, l = 0.42;
  const f = (n) => {
    const k = (n + hue / 30) % 12, a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const BRAND = {
  claude: "#d97757", codex: "#10a37f", node: "#417e38", bun: "#b8693a", deno: "#2f3a45", python: "#3776ab",
  git: "#f05032", docker: "#2496ed", postgres: "#336791", psql: "#336791", nvim: "#4f8a3a", go: "#00add8",
  npm: "#cb3837", cargo: "#a5422b", tsc: "#3178c6", vite: "#646cff", esbuild: "#b08d00", ssh: "#4b5563",
  shell: "#3f4a5a", mcp: "#6d4fd6", "herdr-core": "#0f766e", sqlite3: "#0f80cc", redis: "#d82c20",
};
export const colorOf = (kind) => BRAND[kind.type] ?? BRAND[kind.key] ?? hashColor(kind.key);

/** Memory for people: "612 MB", "2.1 GB". */
export function bytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** "3d", "5h", "12m": how long a process has run. */
export const age = (s) => (s >= 86400 ? `${Math.floor(s / 86400)}d` : s >= 3600 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 60)}m`);

// Dev tooling worth flagging when it runs with no terminal; desktop apps also hang off systemd, so they're left out.
const DEV = new Set(["node", "bun", "bunx", "deno", "npm", "npx", "pnpm", "python", "uv", "uvx", "claude", "codex", "tsc", "go", "cargo", "java"]);

/** A systemd service of its own, as opposed to herdr-core's hold units (hc-hold-*), where escaped terminal processes land. */
const isService = (unit) => unit.endsWith(".service") && !unit.startsWith("hc-hold-") && !/^user@\d+\.service$/.test(unit);

/**
 * Processes of yours whose parent has gone (adopted by pid 1 or a systemd manager) and that are dev tooling.
 * Two groups: Services (each runs as its own systemd unit, so it's meant to) and Detached (escaped a terminal:
 * dev servers, MCPs, daemons and stopped workers nobody ended). Shown with their age, never killed.
 */
export function detached(procs, cpu, inTerminals) {
  const reapers = new Set([1, ...[...procs.values()].filter((p) => p.comm === "systemd").map((p) => p.pid)]);
  const kids = childrenOf(procs);
  const roots = [...procs.values()].filter((p) => {
    if (!p.mine || !reapers.has(p.ppid) || inTerminals.has(p.pid)) return false;
    const k = kindOf(p.comm, p.args);
    return k.type === "mcp" || DEV.has(k.key);
  });
  const group = (id, label, sub, list) => {
    const nodes = list.map((p) => {
      const n = procNode(p.pid, procs, kids, cpu);
      return n && { ...n, sub: [n.sub, isService(p.unit) ? p.unit : ""].filter(Boolean).join(" · ") };
    }).filter(Boolean);
    return nodes.length ? { id, kind: "space", label, sub, status: null, ...total(nodes), children: nodes.sort(byMem) } : null;
  };
  return [
    group("space:services", "Services", "systemd user services", roots.filter((p) => isService(p.unit))),
    group("space:detached", "Detached", "parent gone · not in any terminal", roots.filter((p) => !isService(p.unit))),
  ].filter(Boolean);
}

/** Appends to the list at `key` (made on first use). Not a spread: copying per child is quadratic, slow in QuickJS. */
const push = (map, key, value) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };

/** ppid → child pids, built once per sample and shared. */
export function childrenOf(procs) {
  const kids = new Map();
  for (const p of procs.values()) push(kids, p.ppid, p.pid);
  return kids;
}

const byMem = (a, b) => b.mem - a.mem || a.label.localeCompare(b.label);
const total = (nodes) => nodes.reduce((acc, n) => ({ mem: acc.mem + n.mem, cpu: acc.cpu + n.cpu }), { mem: 0, cpu: 0 });

/**
 * Siblings of the same type (2 or more) fold into one group node with their totals, so the tree reads
 * "MCP ×6" before the six servers. Everything still drills down to single processes.
 */
function groupSiblings(nodes, parentId) {
  const byType = new Map();
  for (const n of nodes) push(byType, n.type, n);
  const out = [];
  for (const [type, list] of byType) {
    if (list.length < 2) { out.push(list[0]); continue; }
    const first = list[0];
    out.push({
      id: `grp:${parentId}:${type}`, kind: "group", type, key: first.key, color: first.color,
      label: `${type === "mcp" ? "MCP servers" : first.label.replace(/ · .*/, "")} ×${list.length}`,
      sub: "", ...total(list), children: list.sort(byMem),
    });
  }
  return out.sort(byMem);
}

/** One process and everything under it. `kids` maps ppid → child pids. */
function procNode(pid, procs, kids, cpu, seen = new Set()) {
  const p = procs.get(pid);
  if (!p || seen.has(pid)) return null;
  seen.add(pid);
  const kind = kindOf(p.comm, p.args);
  const children = (kids.get(pid) ?? []).map((c) => procNode(c, procs, kids, cpu, seen)).filter(Boolean);
  const own = { mem: p.rss, cpu: cpu.get(pid) ?? 0 };
  const below = total(children);
  return {
    id: `proc:${pid}`, kind: "proc", pid, type: kind.type, key: kind.key, color: colorOf(kind), label: kind.label,
    sub: [`pid ${pid}`, p.threads > 1 ? `${p.threads} threads` : ""].filter(Boolean).join(" · "),
    args: p.args, ageS: p.ageS ?? 0,
    own, mem: own.mem + below.mem, cpu: own.cpu + below.cpu,
    children: groupSiblings(children, `proc:${pid}`),
  };
}

/**
 * The whole tree: space › tab › terminal › its processes, every level carrying the totals of what's under it.
 * `terminals`: live hc terminals with `pid` filled in. `spaces`: Herdr's spaces() (for names).
 * Terminals with no Herdr space (hidden `hc run --bg` ones) go under "Background". Workers nest under their parent terminal.
 */
export function buildTree(terminals, procs, cpu, spaces = [], now = Date.now()) {
  const tree = sessionTree(terminals, procs, cpu, spaces, now);
  const inTerminals = new Set(terminals.map((t) => t.pid).filter(Boolean));
  return [...tree, ...detached(procs, cpu, inTerminals)];
}

function sessionTree(terminals, procs, cpu, spaces, now) {
  const kids = childrenOf(procs);
  const spaceById = new Map(spaces.map((s) => [s.id, s]));
  const tabName = new Map(spaces.flatMap((s) => (s.tabs ?? []).map((t) => [t.id, t.name])));
  const terms = new Map();
  for (const t of terminals) {
    if (t.state !== "live" || !t.pid || t.address.includes("/")) continue;
    const proc = procNode(t.pid, procs, kids, cpu);
    if (proc) terms.set(t.address, { t, proc, workers: [] });
  }
  // A worker sits under the terminal that started it (hc `parent`), as Herdr's agent list shows it,
  // not as a session of its own in the worker's space. A parent that has gone leaves it a root.
  // `hc-pane run` panes (dev servers a worker opened) carry no hc parent, only the `hc-pane.owner` label.
  const parentOf = (t) => t.parent ?? t.labels?.["hc-pane.owner"];
  const under = (a, p) => { for (let x = p; x; x = parentOf(terms.get(x)?.t ?? {})) if (x === a) return true; return false; };
  for (const [address, e] of terms) {
    const p = parentOf(e.t);
    if (p && terms.has(p) && !under(address, p)) terms.get(p).workers.push(address);
  }
  const node = (address) => {
    const { t, proc, workers } = terms.get(address);
    owned(proc, t.address);
    const ageS = t.created_ms ? Math.max(0, (now - t.created_ms) / 1000) : proc.ageS;
    const branch = t.labels?.["wtree.branch"];
    const children = [proc, ...workers.map(node).sort(byMem)];
    return {
      id: `term:${t.address}`, kind: "term", address: t.address, program: t.program ?? null, status: t.status ?? null,
      label: t.name || t.program?.name || t.address, ageS, args: t.labels?.where ?? t.where ?? "",
      sub: [t.address, t.turn ? `${t.turn} turns` : "", branch ?? t.labels?.where ?? t.where].filter(Boolean).join(" · "),
      paneless: !t.labels?.["herdr.space"], ...total(children), children,
    };
  };
  const bySpace = new Map();
  for (const [address, { t }] of terms) {
    const p = parentOf(t);
    if (p && terms.has(p) && !under(address, p)) continue;
    const spaceId = t.labels?.["herdr.space"] ?? "background";
    const tabId = t.labels?.["herdr.tab"] ?? "background";
    const tabs = bySpace.get(spaceId) ?? new Map();
    push(tabs, tabId, node(address));
    bySpace.set(spaceId, tabs);
  }
  return [...bySpace].map(([spaceId, tabs]) => {
    const s = spaceById.get(spaceId);
    const tabNodes = [...tabs].map(([tabId, terms]) => ({
      id: `tab:${tabId}`, kind: "tab", spaceId: s ? spaceId : null, tabId: s && tabId !== "background" ? tabId : null, label: tabId === "background" ? "Hidden terminals" : tabName.get(tabId) ?? "Closed tab",
      sub: `${terms.length} terminal${terms.length === 1 ? "" : "s"}`, ...total(terms), children: terms.sort(byMem),
    })).sort(byMem);
    return {
      id: `space:${spaceId}`, kind: "space", spaceId: s ? spaceId : null, label: s?.name ?? (spaceId === "background" ? "Background" : "Closed space"),
      // One tab is just noise between the space and its terminals.
      sub: s?.machine ?? "", status: s?.status ?? null, ...total(tabNodes), children: tabNodes.length === 1 ? tabNodes[0].children : tabNodes,
    };
  }).sort(byMem);
}

/** The rows to draw: depth-first, only under expanded nodes. */
export function visibleRows(tree, expanded, depth = 0, out = []) {
  for (const n of tree) {
    out.push({ node: n, depth, open: expanded.has(n.id), leaf: !n.children?.length });
    if (n.children?.length && expanded.has(n.id)) visibleRows(n.children, expanded, depth + 1, out);
  }
  return out;
}

/** Every id in the tree, for "expand all". */
export const allIds = (tree, out = []) => {
  for (const n of tree) { out.push(n.id); allIds(n.children ?? [], out); }
  return out;
};

/** Marks a terminal's own processes (not its workers, built separately) with the terminal they belong to, for jumping. */
function owned(n, address) {
  n.owner = address;
  for (const c of n.children ?? []) owned(c, address);
}

/** How old something is, for colour: "new" (under a day), "day" (1 to 3 days), "old" (3 days or more). */
export const ageLevel = (s) => (s >= 3 * 86400 ? "old" : s >= 86400 ? "day" : "new");

/**
 * Where a row can jump to, given the terminals that have a pane: a space, a tab, a terminal's pane ("go"),
 * a hidden terminal ("peek"), or a process's own terminal. Null when there's nowhere to go.
 */
export function jumpOf(n, paneTerms) {
  if (n.kind === "space" && n.spaceId) return { kind: "go", run: [["space.select", { id: n.spaceId }]] };
  if (n.kind === "tab" && n.tabId) return { kind: "go", run: [["space.select", { id: n.spaceId }], ["tab.select", { id: n.tabId }]] };
  const address = n.kind === "term" ? n.address : n.owner;
  if (!address) return null;
  return paneTerms.has(address)
    ? { kind: "go", run: [["pane.focus", { terminal: address }]] }
    : { kind: "peek", run: [["terminal.peek", { terminal: address }]] };
}

/** Fills `ageS` on groups, tabs and spaces from their oldest child, so every level can sort by age. */
export function withAges(tree) {
  for (const n of tree) {
    if (n.children?.length) withAges(n.children);
    if (!n.ageS) n.ageS = Math.max(0, ...(n.children ?? []).map((c) => c.ageS ?? 0));
  }
  return tree;
}

const SORTS = {
  mem: (a, b) => b.mem - a.mem,
  cpu: (a, b) => b.cpu - a.cpu || b.mem - a.mem,
  age: (a, b) => (b.ageS ?? 0) - (a.ageS ?? 0),
  name: (a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }),
};

/**
 * A copy of the tree with every level sorted: "mem", "cpu", "age" (oldest first) or "name" (A to Z).
 * `reverse` flips it. Services and Detached stay last either way.
 */
export function sortTree(tree, key, reverse = false, top = true) {
  const base = SORTS[key] ?? SORTS.mem;
  const cmp = reverse ? (a, b) => base(b, a) : base;
  const last = (n) => (top && (n.id === "space:services" || n.id === "space:detached") ? 1 : 0);
  return tree.map((n) => (n.children?.length ? { ...n, children: sortTree(n.children, key, reverse, false) } : n))
    .sort((a, b) => last(a) - last(b) || cmp(a, b));
}

const hay = (n) => [n.label, n.sub, n.args, n.address, n.pid].filter((x) => x !== undefined && x !== null).join(" ").toLowerCase();

/**
 * Narrows the tree. `groups`: which top-level groups to keep ("sessions", "services", "detached"); `minMem`: drop
 * smaller terminals and processes; `query`: words that must all appear in a row (name, pid, address, command line).
 * A matching row keeps its whole subtree; its ancestors stay so the path shows. Totals are left as they were.
 * Returns { tree, open }: `open` holds the ancestors of matches, to expand while searching.
 */
export function filterTree(tree, { groups, minMem = 0, query = "" } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const open = new Set();
  const groupOf = (n) => (n.id === "space:services" ? "services" : n.id === "space:detached" ? "detached" : "sessions");
  const small = (n) => (n.kind === "proc" || n.kind === "term" || n.kind === "group") && n.mem < minMem;
  const walk = (nodes) => nodes.flatMap((n) => {
    if (small(n)) return [];
    if (words.length && words.every((w) => hay(n).includes(w))) return [prune(n)];
    const kids = walk(n.children ?? []);
    if (!kids.length) return words.length ? [] : [prune(n)];
    if (words.length) open.add(n.id);
    return [{ ...n, children: kids }];
  });
  // Keep a matched row's subtree, but still apply the size filter inside it.
  const prune = (n) => (n.children?.length ? { ...n, children: n.children.filter((c) => !small(c)).map(prune) } : n);
  const kept = tree.filter((n) => !groups || groups.has(groupOf(n)));
  return { tree: walk(kept), open };
}
