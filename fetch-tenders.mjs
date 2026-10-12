// Fetches open UK public tenders from Find a Tender (OCDS API) for Shortlist Bid's
// four sectors and writes tenders.json, which shortlistbid.co.uk/tenders reads. Runs daily in GitHub Actions.
// Contains public sector information licensed under the Open Government Licence v3.0.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const OUT = new URL('./tenders.json', import.meta.url);
const API = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const DAYS_BACK = 28;
const MAX_PAGES = 40;
const PAUSE_MS = 11000; // Find a Tender allows roughly 12 requests per window

const CATEGORIES = [
  { key: 'cleaning', label: 'Cleaning and facilities',
    cpv: ['9091', '9090', '9061', '905', '7731', '7734', '79993', '555'] },
  { key: 'security', label: 'Security', cpv: ['7971'] },
  { key: 'care', label: 'Care and support', cpv: ['8531', '85144', '85323'] },
  { key: 'community', label: 'Charities and community', cpv: ['8532', '853000', '9813', '85312300', '85312310', '85312320'] },
];
// Never list construction, engineering or M&E work
const EXCLUDE_CPV = ['45', '507', '71', '3', '0931'];
const EXCLUDE_WORDS = /\b(M&E|mechanical|electrical|HVAC|plumbing|hard FM|construction|refurbishment|boiler|lift maintenance|fire alarm)\b/i;

const REGIONS = { C: 'North East', D: 'North West', E: 'Yorkshire and the Humber', F: 'East Midlands', G: 'West Midlands',
  H: 'East of England', I: 'London', J: 'South East', K: 'South West', L: 'Wales', M: 'Scotland', N: 'Northern Ireland' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cpvOf = (c) => (c && /cpv/i.test(c.scheme || 'CPV') ? String(c.id || '').replace(/\D/g, '') : '');

function categorise(cpv) {
  // most specific prefix wins (so counselling 85312300 lands in community, not care)
  let best = null, bestLen = 0;
  for (const cat of CATEGORIES) for (const p of cat.cpv) {
    if (cpv.startsWith(p) && p.length > bestLen) { best = cat; bestLen = p.length; }
  }
  return best;
}

function regionOf(rel) {
  const codes = [];
  for (const item of rel.tender?.items || []) for (const a of item.deliveryAddresses || []) if (a.region) codes.push(a.region);
  const buyer = (rel.parties || []).find((p) => (p.roles || []).includes('buyer'));
  if (buyer?.address?.region) codes.push(buyer.address.region);
  for (const c of codes) {
    const m = String(c).toUpperCase().match(/^(?:UK|TL)([C-N])/);
    if (m) return REGIONS[m[1]];
  }
  return buyer?.address?.locality || '';
}

export function toTender(rel, now = new Date()) {
  const t = rel.tender || {};
  if (t.status && t.status !== 'active') return null;
  const end = t.tenderPeriod?.endDate;
  if (!end || new Date(end) <= now) return null;
  const main = cpvOf(t.classification);
  const extra = (t.items || []).flatMap((i) => [i.classification, ...(i.additionalClassifications || [])]).map(cpvOf).filter(Boolean);
  if (main && EXCLUDE_CPV.some((p) => main.startsWith(p))) return null;
  const title = (t.title || '').trim();
  if (!title || EXCLUDE_WORDS.test(title)) return null;
  const cat = categorise(main) || extra.map(categorise).find(Boolean);
  if (!cat) return null;
  const buyer = (rel.parties || []).find((p) => (p.roles || []).includes('buyer'));
  let value = t.value?.amount;
  if (!value && Array.isArray(t.lots)) value = t.lots.reduce((s, l) => s + (l.value?.amount || 0), 0) || null;
  const noticeId = (String(rel.id || '').match(/^\d{6}-\d{4}/) || [])[0];
  const desc = (t.description || '').replace(/\s+/g, ' ').trim();
  return {
    id: noticeId || rel.ocid || rel.id,
    title,
    buyer: buyer?.name || rel.buyer?.name || '',
    region: regionOf(rel),
    category: cat.key,
    value: value || null,
    currency: t.value?.currency || 'GBP',
    deadline: end,
    published: rel.date || null,
    summary: desc.length > 220 ? desc.slice(0, 217).replace(/\s+\S*$/, '') + '…' : desc,
    url: noticeId ? `https://www.find-tender.service.gov.uk/Notice/${noticeId}` : 'https://www.find-tender.service.gov.uk/Search',
  };
}

async function fetchAll() {
  const from = new Date(Date.now() - DAYS_BACK * 864e5).toISOString().slice(0, 19);
  let url = `${API}?stages=tender&limit=100&updatedFrom=${from}`;
  const releases = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'ShortlistBid-tender-finder/1.0 (+https://shortlistbid.co.uk)' } });
      if (res.status !== 429 && res.status < 500) break;
      await sleep(PAUSE_MS * (attempt + 2));
    }
    if (!res.ok) throw new Error(`Find a Tender returned ${res.status}`);
    const json = await res.json();
    releases.push(...(json.releases || []));
    url = json.links?.next || null;
    if (url) await sleep(PAUSE_MS);
  }
  return releases;
}

async function main() {
  const now = new Date();
  let previous = [];
  try { previous = JSON.parse(await readFile(OUT, 'utf8')).tenders || []; } catch {}
  const releases = process.env.FIXTURE ? JSON.parse(await readFile(process.env.FIXTURE, 'utf8')).releases : await fetchAll();

  const byId = new Map();
  for (const p of previous) if (new Date(p.deadline) > now) byId.set(p.id, p); // keep still-open ones
  for (const rel of releases.sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const t = toTender(rel, now);
    if (t) byId.set(t.id, t);
    else if (rel.id) { const id = (String(rel.id).match(/^\d{6}-\d{4}/) || [])[0]; if (id && byId.has(id) && rel.tender?.status && rel.tender.status !== 'active') byId.delete(id); }
  }
  const tenders = [...byId.values()].sort((a, b) => a.deadline.localeCompare(b.deadline));
  await mkdir(new URL('.', OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ updated: now.toISOString(), source: 'Find a Tender (UK Government)', licence: 'Open Government Licence v3.0', count: tenders.length, tenders }, null, 1) + '\n');
  console.log(`Fetched ${releases.length} releases; ${tenders.length} open tenders written.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
