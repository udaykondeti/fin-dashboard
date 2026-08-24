#!/usr/bin/env node
// Seed the property shortlist for the Narsingi / Kokapet / Puppalaguda 3 BHK
// search. Rows are idempotently upserted on (user_id, project_name).
//
// Sources: the user's own flatsearchrajapushpaarea.docx plus research done
// by parallel Explore agents (public listings on 99acres, Squareyards,
// Housiey, official builder sites). Fields marked "unverified" in the
// research remain nullable — user should confirm on a site visit.
//
// Usage:
//   node scripts/seed-property-shortlist-rajapushpa.js --email kondetiudaykiran@gmail.com
//   node scripts/seed-property-shortlist-rajapushpa.js --email <addr> --dry-run

require('dotenv').config();
const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'server', 'db', 'finance.db');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const emailIdx = args.indexOf('--email');
const email = emailIdx >= 0 ? args[emailIdx + 1] : null;
if (!email) { console.error('--email <address> is required'); process.exit(1); }

const db = require('../server/db/database');

const gmap = (query) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

// ── Base data merged from the doc + research ────────────────────────────────
const ROWS = [
  {
    project_name: 'My Home Tarkshya',
    locality: 'Kokapet', city: 'Hyderabad',
    builder: 'My Home Constructions',
    address: 'Neopolis, Kokapet, Hyderabad 500075',
    maps_url: gmap('My Home Tarkshya Kokapet Hyderabad'),
    project_url: 'https://www.myhomeconstructions.com/my-home-tarkshya/',
    size_sqft: 1956, facing: 'North-East', floor: '4th', bhk: 3, ask_price: null,
    project_status: 'Ready (possession from Jul 2023)',
    total_units: 660, total_towers: 4, floors_per_tower: 32, size_range: '1957-2235 sqft',
    maintenance_per_sqft: 3.75,
    maintenance_notes: '~₹3.5-4/sqft/month per resident chatter; corpus fund collected at handover. Verify with RWA.',
    amenities: ['~34,000 sqft clubhouse', 'Swimming pool', 'Gym', 'Indoor games', 'Community hall', 'Jogging track', "Kids' play", 'Landscaped gardens', 'CCTV', 'Covered parking', '24-hr power backup'],
    healthcare: [
      { name: 'Continental Hospitals Gachibowli', distance_km: 4, type: 'Tertiary' },
      { name: 'AIG Hospitals Gachibowli', distance_km: 5, type: 'Tertiary' },
      { name: 'Care Hospitals Banjara / Nanakramguda', distance_km: 6, type: 'Tertiary' }
    ],
    banks: [
      { name: 'HDFC / ICICI / SBI / Axis branches, Kokapet main road', distance_km: 1 }
    ],
    schools: [
      { name: 'The Gaudium', distance_km: 1 },
      { name: 'DPS Kollur', distance_km: 5 },
      { name: 'Samasti International', distance_km: 4 }
    ],
    transit: {
      metro: 'Raidurg (nearest, ~7 km). Pink Line extension to Kokapet under construction (timeline unverified).',
      bus: 'RTC bus stops on Kokapet main road',
      cab_availability: 'Ola/Uber readily available from gate',
      notes: 'No walkable transit; auto/cab is the default'
    },
    groceries: [
      { name: 'More Supermarket', distance_km: 1.5, type: 'Supermarket' },
      { name: 'Ratnadeep', distance_km: 2, type: 'Supermarket' },
      { name: 'Apollo / MedPlus pharmacies', distance_km: 1, type: 'Pharmacy' }
    ],
    worship: [{ name: 'Sri Venkateswara temple, Kokapet village', distance_km: 1, type: 'Temple' }],
    senior_fit_score: 62,
    senior_notes: '32-floor high-rise; lift-dependent for mid-floors. Wide lobbies, ramps at entrance, 100% DG backup on lifts. No formal senior-focused amenity. Auto/cab pickup easy at gate. Best suited if the couple is comfortable with high-rise living and doesn\'t need walking-distance hospitals.',
    red_flags: [
      '32-floor high-rise → long lift waits at peak',
      'Unit price ~₹2.3-2.6 Cr may be heavy for a downsize',
      'Nearest tertiary hospital 4+ km via ORR traffic',
      'No operational metro',
      'Monsoon waterlogging historically reported on Kokapet approach roads'
    ],
    elevator_count: 4, power_backup: '100% DG on common areas + lifts (unverified per tower)',
    notes: 'BEST MATCH per original doc: corpus fund settled, 2 covered parking, semi-furnished, floor 4 matches preference, North-East facing.'
  },
  {
    project_name: 'My Home Avatar',
    locality: 'Puppalaguda', city: 'Hyderabad',
    builder: 'My Home Constructions',
    address: 'Puppalaguda, near Manikonda/Narsingi, Hyderabad 500089',
    maps_url: gmap('My Home Avatar Puppalaguda Hyderabad'),
    project_url: 'https://www.myhomeconstructions.com/my-home-avatar/',
    size_sqft: null, facing: null, floor: null, bhk: 3, ask_price: null,
    project_status: 'Ready (possession ~2020, fully occupied)',
    total_units: 2800, total_towers: 10, floors_per_tower: null, size_range: '1180-2100 sqft (2/3 BHK)',
    maintenance_per_sqft: 3.0,
    maintenance_notes: '₹2.5-3.5/sqft/month reported by residents; sinking fund active. Verify with RWA.',
    amenities: ['Large clubhouse', 'Gym', 'Swimming pool', 'Amphitheatre', 'Cricket pitch', 'Tennis / Basketball / Volleyball', 'Skating rink', 'Jogging + cycling tracks', "Kids' play", 'Senior citizens\' zone', 'Meditation zone', 'Pet park', 'Creche', '24×7 CCTV / intercom', 'DG backup', '84% open space'],
    healthcare: [
      { name: 'Care Hospitals Banjara Hills route', distance_km: 5.5 },
      { name: 'Continental Gachibowli', distance_km: 5 },
      { name: 'AIG Gachibowli', distance_km: 6 },
      { name: 'Apollo Clinic, Manikonda main road', distance_km: 2, type: 'Clinic' }
    ],
    banks: [{ name: 'HDFC, ICICI, SBI, Kotak, Axis — Manikonda / Puppalaguda main road', distance_km: 1.5 }],
    schools: [
      { name: 'DPS Nacharam-branch', distance_km: 3 },
      { name: 'Sancta Maria / Meridian / Glendale', distance_km: 4 }
    ],
    transit: {
      metro: 'Raidurg via Nanakramguda ~8 km',
      bus: 'TSRTC on Puppalaguda–Manikonda route (frequent)',
      cab_availability: 'Very easy — mature demand pocket, autos & Ola/Uber abundant',
      notes: 'One of the more cab-friendly localities'
    },
    groceries: [
      { name: 'Ratnadeep', distance_km: 1.5, type: 'Supermarket' },
      { name: 'More', distance_km: 2, type: 'Supermarket' },
      { name: 'DMart Manikonda', distance_km: 2 },
      { name: 'Q-Mart (in-complex retail)', distance_km: 0, type: 'Convenience' },
      { name: 'Apollo Pharmacy / MedPlus at gate', distance_km: 0.2, type: 'Pharmacy' }
    ],
    worship: [
      { name: 'ISKCON temple Narsingi', distance_km: 4 },
      { name: 'Ayyappa temple Manikonda', distance_km: 2 }
    ],
    senior_fit_score: 80,
    senior_notes: 'Explicit senior-citizens\' zone + meditation zone — the only shortlist option with an on-brochure senior amenity. Multiple lifts per tower with DG backup. Wide internal roads, flat gradient, tree-lined walking loops for daily walks. Ramps and lobby seating in most towers. Lived-in community means neighbourly support already exists — a plus for seniors. Cab from gate is very easy.',
    red_flags: [
      '2,800 units → can feel crowded; lifts busy at peak',
      'Older builds may need refurb in resale units',
      'Puppalaguda Rd has school-hours traffic',
      'Some inner lanes flood in heavy monsoon',
      'Verify tower-specific lift count + DG capacity before buying a specific unit'
    ],
    elevator_count: null, power_backup: 'DG on common areas + lifts (per-tower unverified)',
    notes: 'Not on the user\'s original shortlist but strong senior-fit; consider adding to visit list.'
  },
  {
    project_name: 'Prestige Tranquil',
    locality: 'Kokapet', city: 'Hyderabad',
    builder: 'Prestige Group',
    address: 'Kokapet, Rajendra Nagar Mandal, Hyderabad 500075',
    maps_url: gmap('Prestige Tranquil Kokapet Hyderabad'),
    project_url: 'https://www.prestigeconstructions.com/projects/prestige-tranquil',
    size_sqft: 2049, facing: 'East', floor: '15th', bhk: 3, ask_price: null,
    project_status: 'Handover imminent/ongoing (RERA stated completion Sep-2026)',
    total_units: 906, total_towers: 4, floors_per_tower: 34, size_range: '1390-2049 sqft (some 3.5 BHK to 2900+ sqft)',
    maintenance_per_sqft: 5.0,
    maintenance_notes: 'Not officially published. Prestige premium projects typically ₹4-6/sqft/month with sizeable corpus at handover.',
    amenities: ['Clubhouse', 'Swimming pool', 'Gym', 'Squash court', 'Badminton court', 'Indoor games', 'Banquet/party hall', 'Café', 'Landscaped gardens', "Kids' play", 'Jogging track', '24/7 security'],
    healthcare: [
      { name: 'Continental Hospital Gachibowli', distance_km: 4.5 },
      { name: 'AIG Hospitals Gachibowli', distance_km: 7 },
      { name: 'Care Hospitals Financial District', distance_km: 3.5 }
    ],
    banks: [{ name: 'HDFC, ICICI, SBI, Axis — Kokapet main road & Financial District', distance_km: 2 }],
    schools: [
      { name: 'Rockwell International', distance_km: 2 },
      { name: 'Oakridge International', distance_km: 4 },
      { name: 'Phoenix Greens', distance_km: 3 }
    ],
    transit: {
      metro: 'Raidurg (Blue Line) ~7-8 km. Kokapet extension planned but not operational (unverified).',
      bus: 'Limited on Kokapet Rd',
      cab_availability: 'Readily available given Financial District proximity',
      notes: 'ORR access ~2.6 km'
    },
    groceries: [
      { name: 'Ratnadeep', distance_km: 1.5 },
      { name: 'More', distance_km: 2 },
      { name: 'Apollo & MedPlus pharmacies', distance_km: 1, type: 'Pharmacy' }
    ],
    worship: [{ name: 'Local temples in Kokapet village', distance_km: 1.5 }],
    senior_fit_score: 55,
    senior_notes: 'Multiple high-speed elevators per tower with 100% DG backup (Prestige standard). Wide corridors and ramps at lobby. Cab hailing from gate is easy. However, large ~8-acre campus means longer internal walks (gate-to-tower 100-300m). Floor 15 above the user\'s preferred range.',
    red_flags: [
      'Fresh handover — year-1 teething issues common (lift commissioning, water, finishing snags)',
      'Large campus = long internal walks',
      'No hospital in walking distance',
      'Metro is not truly close despite marketing',
      'Floor 15 on this candidate above user\'s 4-10 preference'
    ],
    elevator_count: null, power_backup: '100% DG (Prestige standard, count unverified)',
    notes: 'Facing/size match per user\'s doc, but floor too high (15th vs 4-10 target).'
  },
  {
    project_name: 'Lansum Etania',
    locality: 'Nanakramguda', city: 'Hyderabad',
    builder: 'Lansum Properties LLP',
    address: 'Nanakramguda, Serilingampally, Hyderabad 500032 (behind ISB)',
    maps_url: gmap('Lansum Etania Nanakramguda Hyderabad'),
    project_url: 'https://lansumproperties.com/projects/lansum-etania/',
    size_sqft: 2165, facing: 'East', floor: '18th', bhk: 3, ask_price: null,
    project_status: 'Ready (possession from Oct 2019, 6+ yrs occupied)',
    total_units: 372, total_towers: 7, floors_per_tower: 20, size_range: '1890-4085 sqft (3-4 BHK)',
    maintenance_per_sqft: 4.0,
    maintenance_notes: '₹3.5-4.5/sqft/month reported by residents (99acres/NoBroker forums, unverified officially).',
    amenities: ['Clubhouse', 'Swimming pool', 'Gym', 'Multipurpose/banquet hall', 'Landscaped garden', "Kids' play", 'Indoor games', 'Power backup', '24/7 security'],
    healthcare: [
      { name: 'Yashoda Hospital Financial District (WALKABLE < 500 m)', distance_km: 0.5, type: 'Tertiary — WALKABLE' },
      { name: 'Continental Hospital', distance_km: 2.5 },
      { name: 'Care Hospitals Financial District', distance_km: 1.5 }
    ],
    banks: [{ name: 'Financial District bank cluster (Wells Fargo, ICICI, HDFC corporate)', distance_km: 1 }],
    schools: [
      { name: 'Oakridge International Gachibowli', distance_km: 3.5 },
      { name: 'Rockwell', distance_km: 4 },
      { name: 'Phoenix Greens', distance_km: 3 }
    ],
    transit: {
      metro: 'Raidurg (Blue Line terminus) ~5-6 km',
      bus: 'TSRTC on ORR service road & Gachibowli-Wipro Circle',
      cab_availability: 'Abundant — Ola/Uber/Rapido steady given office density',
      notes: 'Peak-hour cab pickup slower 9-10am / 6-8pm'
    },
    groceries: [
      { name: 'Ratnadeep Supermarket Nanakramguda', distance_km: 1 },
      { name: 'More / Q-Mart', distance_km: 1.5 },
      { name: 'Sarath City Capital Mall', distance_km: 4, type: 'Mall' }
    ],
    worship: [{ name: 'Small temples in Nanakramguda village', distance_km: 1 }],
    senior_fit_score: 85,
    senior_notes: 'STRONGEST SENIOR ADVANTAGE: Yashoda Hospital is walkable (<500m). Compact 8-acre / 372-unit footprint = shorter internal walks than Prestige Tranquil. Multiple elevators per tower with DG backup, ramps and wide lobbies. Cabs easy from gate. Only downside: floor 18 (on this candidate) is above the user\'s 4-10 preference range.',
    red_flags: [
      'Older-generation finishes vs 2026 launches',
      'Anecdotal lift wait times at peak; water pressure issues on higher floors (unverified)',
      'Peak-hour cab availability can slow 9-10am / 6-8pm',
      'Floor 18 on this candidate above user\'s 4-10 preference — ask broker for lower-floor resale inventory'
    ],
    elevator_count: null, power_backup: 'DG typical for 20-floor luxury build (unverified)',
    notes: 'Facing/size match per user\'s doc. Only shortlist option with a walking-distance hospital — huge plus for seniors. Push broker for a floor-4-to-10 resale unit here.'
  },
  {
    project_name: 'Rajapushpa Provincia',
    locality: 'Narsingi', city: 'Hyderabad',
    builder: 'Rajapushpa Properties',
    address: 'Off Outer Ring Road, Narsingi, Hyderabad 500089',
    maps_url: gmap('Rajapushpa Provincia Narsingi Hyderabad'),
    project_url: 'https://www.rajapushpa.in/projects/residential/rajapushpaprovincia.php',
    size_sqft: 2128, facing: null, floor: null, bhk: 3, ask_price: 30500000,
    project_status: 'Phase 1 handed over (few units left); Phase 2 under construction, possession Jan 2027',
    total_units: 3498, total_towers: 11, floors_per_tower: 39, size_range: '1370-2660 sqft (2/3 BHK)',
    maintenance_per_sqft: 3.75,
    maintenance_notes: '₹3.5-4/sqft/month for Phase 1 (broker chatter, unverified). Corpus collected at possession, amount not publicly disclosed.',
    amenities: ['80+ amenities', 'Two clubhouses (~150,000 sqft)', 'Swimming pools', 'Gym', 'Yoga/aerobics zones', 'Tennis/badminton/squash/basketball', 'Indoor games', "Kids' play", 'Jogging track', 'Amphitheatre', 'Podium gardens', "Senior citizens' area (unverified)", 'IGBC Pre-Gold'],
    healthcare: [
      { name: 'Care Hospitals Nanakramguda / Prathima Narsingi', distance_km: 2.5 },
      { name: 'Continental Hospitals Gachibowli', distance_km: 5 },
      { name: 'AIG Hospitals Gachibowli', distance_km: 6 }
    ],
    banks: [{ name: 'HDFC, ICICI, SBI ATMs — Narsingi-ORR service road', distance_km: 0.75 }],
    schools: [
      { name: 'Glendale Academy', distance_km: 4 },
      { name: 'Rockwell International', distance_km: 5 }
    ],
    transit: {
      metro: 'None — Raidurg ~8 km',
      bus: 'TSRTC limited on Narsingi-ORR',
      cab_availability: 'Autos/Ola/Uber readily available at gate given Financial District proximity',
      notes: 'Podium walkways and internal buggy service — buggy unverified'
    },
    groceries: [
      { name: 'More Supermarket', distance_km: 1 },
      { name: 'Ratnadeep', distance_km: 1 },
      { name: 'Local kirana + pharmacies on Narsingi main road', distance_km: 1 }
    ],
    worship: [{ name: 'Small temples in Narsingi village', distance_km: 1.5 }],
    senior_fit_score: 55,
    senior_notes: 'G+39 towers = heavy lift-dependency; long evacuation paths in outage. Podium walking paths, benches, shaded gardens are good for intra-community walks. Wide lobbies, ramps at tower entries (typical IGBC). Auto/cab hailing easy at main gate. Doctor-on-call unverified; senior-citizen area is listed but requires site walk to confirm.',
    red_flags: [
      'Very tall towers (G+39) → lift-dependent, long evacuation',
      'Large under-construction Phase 2 adjacent = dust/noise for years',
      'Nothing walkable outside gate — no ORR service road footpaths',
      'Nearest tertiary hospital 5+ km via ORR feeder traffic',
      'Ask price ₹3.05 Cr listed as non-negotiable per user\'s doc — confirm facing/floor directly'
    ],
    elevator_count: 4, power_backup: 'DG typical for G+39 (per-tower verify)',
    notes: 'User\'s reference point (originally targeted). Facing/floor still to be confirmed with broker; ₹3.05 Cr Phase 1 unit is on the pricier end.'
  },
  {
    project_name: 'Rajapushpa Provincia (smaller 3 BHK)',
    locality: 'Narsingi', city: 'Hyderabad',
    builder: 'Rajapushpa Properties',
    address: 'Off Outer Ring Road, Narsingi, Hyderabad 500089',
    maps_url: gmap('Rajapushpa Provincia Narsingi Hyderabad'),
    project_url: 'https://www.rajapushpa.in/projects/residential/rajapushpaprovincia.php',
    size_sqft: 1868, facing: null, floor: null, bhk: 3, ask_price: 26000000,
    project_status: 'Phase 1 handed over',
    total_units: 3498, total_towers: 11, floors_per_tower: 39, size_range: '1370-2660 sqft',
    maintenance_per_sqft: 3.75,
    amenities: ['Same as main Provincia listing above'],
    senior_fit_score: 55,
    senior_notes: 'Slightly below the 2000-2300 sqft target range from the user\'s doc, but ₹45 lakh cheaper than the 2128 sqft unit — worth considering if the couple wants a smaller layout.',
    red_flags: ['Slightly below the 2000-2300 sqft target', 'Same tower-height red flags as sibling row'],
    notes: 'Same project, smaller floor plan. Same phone/broker as main listing.'
  },
  {
    project_name: 'EIPL Skyila',
    locality: 'Puppalaguda / Manikonda', city: 'Hyderabad',
    builder: 'EIPL Group',
    address: 'Puppalaguda, off Manikonda-Narsingi road, Hyderabad 500089',
    maps_url: gmap('EIPL Skyila Puppalaguda Manikonda Hyderabad'),
    project_url: 'https://www.eiplgroup.com/',
    size_sqft: null, facing: null, floor: null, bhk: 3, ask_price: null,
    project_status: 'Ready (possession from Aug 2018, resale market active)',
    total_units: 180, total_towers: null, floors_per_tower: 14, size_range: '1320-2190 sqft (2/3 BHK)',
    maintenance_per_sqft: 2.75,
    maintenance_notes: '₹2.5-3/sqft/month (resale-listing chatter, unverified). Society is resident-managed.',
    amenities: ['Clubhouse', 'Swimming pool', 'Gym', 'Tennis + shuttle court', 'Amphitheatre', 'Meditation hall', 'Library', 'Landscaped garden', 'Indoor + outdoor games', "Kids' play", '24×7 water + power backup', 'CCTV', 'Gated security', 'Covered parking'],
    healthcare: [
      { name: 'Bhoomi Hospitals Puppalaguda', distance_km: 1, type: 'Local' },
      { name: 'Rex Superspeciality / Joy / PULSE Hospital', distance_km: 4 },
      { name: 'Care Hospitals Nanakramguda', distance_km: 5 }
    ],
    banks: [{ name: 'HDFC, ICICI, Axis, SBI — Puppalaguda main road', distance_km: 0.75 }],
    schools: [
      { name: 'Pavithra International / Elate International', distance_km: 2 },
      { name: 'Gitanjali Vedika', distance_km: 1.5 },
      { name: 'DPS Khajaguda', distance_km: 4 }
    ],
    transit: {
      metro: 'Raidurg terminus ~6 km',
      bus: 'TSRTC moderate on Manikonda-Puppalaguda road',
      cab_availability: 'Very good — dense Manikonda pocket',
      notes: 'Groceries/pharmacy within 10-min walk of gate — better for non-drivers than Narsingi'
    },
    groceries: [
      { name: 'Ratnadeep / More / Q-Mart / Heritage Fresh', distance_km: 1 },
      { name: 'Apollo / MedPlus', distance_km: 0.5, type: 'Pharmacy' }
    ],
    worship: [{ name: 'Puppalaguda / Manikonda village temples', distance_km: 1 }],
    senior_fit_score: 72,
    senior_notes: 'Compact community — short walks between blocks, benches in central garden. Puppalaguda has narrow-but-walkable roads with some footpath; groceries/pharmacy within 10-min walk of gate — GOOD for non-drivers. Auto/cab availability at gate very good. Bhoomi Hospital 1 km (local level, not tertiary).',
    red_flags: [
      'Older project — check lift-modernization, seepage/plumbing status',
      'Puppalaguda main road has heavy traffic and inconsistent footpaths',
      'Nearest tertiary hospital (AIG/Continental) 6-8 km via congested roads',
      'Confirm which "Skyila" — Aryamitra Skyila (older) is a separate weaker project'
    ],
    elevator_count: 2, power_backup: 'DG standard (unverified per tower)',
    notes: 'Not on the user\'s original shortlist — worth adding for walkability + Bhoomi Hospital proximity.'
  }
];

function upsert(userId, r) {
  const cols = Object.keys(r);
  const jsonFields = new Set(['amenities', 'healthcare', 'banks', 'schools', 'transit', 'groceries', 'worship', 'red_flags']);
  const existing = db.prepare(
    'SELECT id FROM property_shortlist WHERE user_id = ? AND project_name = ? AND COALESCE(size_sqft,0) = COALESCE(?,0)'
  ).get(userId, r.project_name, r.size_sqft);

  const values = cols.map(c => {
    const v = r[c];
    if (jsonFields.has(c) && v != null && typeof v !== 'string') return JSON.stringify(v);
    return v == null ? null : v;
  });

  if (existing) {
    const sets = cols.map(c => c + '=?').join(', ');
    db.prepare(`UPDATE property_shortlist SET ${sets}, researched_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...values, existing.id);
    return { action: 'updated', id: existing.id };
  }
  const insCols = ['user_id', ...cols, 'researched_at'];
  const q = `?,` .repeat(insCols.length - 1) + 'CURRENT_TIMESTAMP';
  const stmt = db.prepare(`INSERT INTO property_shortlist (${insCols.join(',')}) VALUES (${q})`);
  const info = stmt.run(userId, ...values);
  return { action: 'inserted', id: Number(info.lastInsertRowid) };
}

function main() {
  const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
  if (!user) { console.error(`No user with email ${email}`); process.exit(1); }
  console.log(`Target user: #${user.id} ${user.email}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'WRITE'}\n`);

  if (dryRun) {
    for (const r of ROWS) console.log(`  ${r.project_name} — ${r.locality} — ${r.size_sqft || '?'} sqft — score ${r.senior_fit_score}`);
    return;
  }

  const tally = { inserted: 0, updated: 0 };
  for (const r of ROWS) {
    const res = upsert(user.id, r);
    tally[res.action]++;
    console.log(`  [${res.action}] #${res.id}  ${r.project_name} (${r.locality}) — score ${r.senior_fit_score}`);
  }
  console.log(`\nDone. inserted=${tally.inserted}  updated=${tally.updated}`);
}

try { main(); }
catch (e) { console.error('FAIL:', e.message); process.exit(1); }
