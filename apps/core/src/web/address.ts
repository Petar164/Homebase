import { isIP } from "node:net";

// Which network addresses HELIOS may contact when it opens a web page.
//
// A page address comes from a search result, from a model or from the page
// itself (a redirect), so it is never trusted. Without these checks a page
// could point HELIOS at this machine, at the home network or at a cloud
// provider's metadata service, and read what only they can reach. Only
// addresses on the public internet pass. Everything else is refused, and the
// rule is "refuse unless known public", not "allow unless known private".

/** Why an address is not a public one, in a few words. Null when it is public. */
export function addressProblem(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return ipv4Problem(parseIpv4(address));
  if (family === 6) return ipv6Problem(address);
  return "not a network address";
}

function parseIpv4(address: string): number[] {
  return address.split(".").map(Number);
}

function ipv4Problem(octets: number[]): string | null {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0) return "an unspecified address";
  if (a === 10) return "a private network";
  if (a === 100 && b >= 64 && b <= 127) return "a carrier's shared network";
  if (a === 127) return "this machine";
  if (a === 169 && b === 254) return "a link-local address (this is where cloud metadata services live)";
  if (a === 172 && b >= 16 && b <= 31) return "a private network";
  if (a === 192 && b === 0 && c === 0) return "a reserved network";
  if (a === 192 && b === 0 && c === 2) return "a documentation network";
  if (a === 192 && b === 88 && c === 99) return "a reserved network";
  if (a === 192 && b === 168) return "a private network";
  if (a === 198 && (b === 18 || b === 19)) return "a test network";
  if (a === 198 && b === 51 && c === 100) return "a documentation network";
  if (a === 203 && b === 0 && c === 113) return "a documentation network";
  if (a >= 224 && a <= 239) return "a multicast address";
  if (a >= 240) return "a reserved address";
  return null;
}

/** The eight 16-bit groups of an IPv6 address, or null when it cannot be read. */
function parseIpv6(address: string): number[] | null {
  // A zone ("fe80::1%eth0") names an interface of this machine.
  if (address.includes("%")) return null;
  let text = address;
  // The last 32 bits may be written as an IPv4 address.
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail?.[1] !== undefined && tail[2] !== undefined) {
    const octets = parseIpv4(tail[2]);
    if (octets.length !== 4 || octets.some((octet) => !(octet >= 0 && octet <= 255))) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const read = (part: string) => (part === "" ? [] : part.split(":").map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : Number.NaN)));
  const head = read(halves[0] ?? "");
  const rest = halves.length === 2 ? read(halves[1] ?? "") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => 0), ...rest];
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

function ipv6Problem(address: string): string | null {
  const groups = parseIpv6(address);
  if (!groups) return "not a usable network address";
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;

  if (leadingZero && g4 === 0 && g5 === 0) {
    if (g6 === 0 && g7 === 0) return "an unspecified address";
    if (g6 === 0 && g7 === 1) return "this machine";
    return "an old way of writing an IPv4 address";
  }
  // An IPv4 address written as IPv6: the IPv4 rules decide.
  if (leadingZero && g4 === 0 && g5 === 0xffff) return ipv4Problem(embedded);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return ipv4Problem(embedded);
  if (g0 === 0x64 && g1 === 0xff9b) return "a translation prefix for local use";

  // The public internet is 2000::/3. Inside it, a few ranges are set aside.
  if ((g0 & 0xe000) !== 0x2000) {
    if ((g0 & 0xfe00) === 0xfc00) return "a private network";
    if ((g0 & 0xffc0) === 0xfe80) return "a link-local address";
    if ((g0 & 0xff00) === 0xff00) return "a multicast address";
    return "not an address on the public internet";
  }
  if (g0 === 0x2001 && g1 < 0x0200) return "a range reserved for special protocols";
  if (g0 === 0x2001 && g1 === 0x0db8) return "a documentation network";
  // 6to4 carries an IPv4 address inside it, which could be a private one.
  if (g0 === 0x2002) return "a tunnelled IPv4 address";
  if (g0 === 0x3fff && g1 < 0x1000) return "a documentation network";
  return null;
}

/** Endings of names that belong to a home, an office or a cluster, never to the public internet. */
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa", ".svc", ".private", ".localdomain"];

/**
 * Why a host name must not be contacted, judged from the name alone. Null
 * when the name is acceptable; what it resolves to is checked again at the
 * moment of connecting (see http.ts).
 */
export function hostProblem(hostname: string): string | null {
  // The URL parser writes IPv6 addresses in brackets.
  const bare = hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(bare)) return addressProblem(bare);
  const name = hostname.toLowerCase().replace(/\.$/, "");
  if (!name || name.length > 253) return "not a usable host name";
  if (!/^[a-z0-9.-]+$/.test(name)) return "not a usable host name";
  // "localhost", "router", "metadata": names without a dot are never public sites.
  if (!name.includes(".")) return "a name on the local network";
  if (INTERNAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return "a name on a private network";
  return null;
}
