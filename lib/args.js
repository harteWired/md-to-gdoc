// Minimal argv parser: splits positionals from --flags. Repeated flags become
// arrays; bare flags (no following value) are booleans.
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = key in flags ? [].concat(flags[key], next) : next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}
