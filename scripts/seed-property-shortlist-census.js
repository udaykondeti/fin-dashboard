#!/usr/bin/env node
// Census loader for the Kokapet/Neopolis and Narsingi/Puppalaguda/Gandipet legs.
//
// MERGE SEMANTICS, NOT OVERWRITE. Several of these projects already exist in the
// table with hand-researched enrichment (senior_fit_score, healthcare JSON,
// senior_notes). A plain UPDATE would null those out. So for an existing row this
// script only fills columns that are currently NULL and leaves every populated
// value alone. Re-running is therefore safe and additive.
//
// Price handling: ask_price is the ask on ONE specific unit. Census rows have
// project-wide bands instead ("from Rs 2.47 Cr", "Rs 3.16-4.52 Cr"), which go to
// price_min/price_max. Putting a band into ask_price would misrepresent a
// starting price as a real ask.
//
// Usage: node scripts/seed-property-shortlist-census.js --email <address> [--dry]

const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db', 'database'));

function arg(n) { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; }
const email = arg('--email');
const dry = process.argv.includes('--dry');
if (!email) { console.error('--email <address> is required'); process.exit(1); }

const cr = n => (n == null ? null : Math.round(n * 1e7));
const gmap = q => 'https://www.google.com/maps/search/' + encodeURIComponent(q + ' Hyderabad');

// [name, locality, builder, units, towers, floors, size_range, priceMinCr, priceMaxCr, status, rera, note]
const RAW = [
  // ── Kokapet ────────────────────────────────────────────────────────────────
  ['My Home Apas','Kokapet','My Home Constructions',1338,6,44,'2765-3860 sqft',2.80,null,'Under construction (possession Aug 2028)',null,null],
  ['My Home Tarkshya','Kokapet','My Home Constructions',660,4,32,'1957-2235 sqft',2.47,null,'Ready to move',null,null],
  ['Rajapushpa Regalia','Kokapet','Rajapushpa Properties',null,null,null,null,null,null,'Ready to move',null,'491 ready-to-occupy units across 3 towers reported elsewhere; unit count not confirmed this run'],
  ['Rajapushpa Atria','Kokapet','Rajapushpa Properties',null,null,null,null,null,null,null,null,null],
  ['Rajapushpa The Retreat','Kokapet','Rajapushpa Properties',193,null,null,'1250-2107 sqft (2/3 BHK)',null,null,null,null,null],
  ['Rajapushpa Casa Luxura','Kokapet','Rajapushpa Properties',null,null,null,null,null,null,'Under construction (possession Nov 2028)','P02400007302','Has a senior-citizen lounge on a 30,000 sqft recreation level'],
  ['Rajapushpa Pristinia','Kokapet','Rajapushpa Properties',null,null,null,null,null,null,null,null,null],
  ['Prestige Tranquil','Kokapet','Prestige Group',906,4,35,null,1.47,2.65,null,'P02400002236',null],
  ['Prestige Clairemont','Kokapet','Prestige Group',928,4,39,null,3.16,4.52,null,'P02400005677',null],
  ['Godrej Madison Avenue','Kokapet','Godrej Properties',null,null,null,null,2.8,4.3,'New launch',null,'POSSIBLE DUPLICATE of Godrej Neopolis - sources disagree on whether these are one project or two. Verify before acting.'],
  ['Trump Golden Mile / IRA Trump Tower','Kokapet','IRA Realty / Trump',null,null,null,null,3.5,18.0,'New launch',null,null],
  ['Fortune Suraj Bhan Grande','Kokapet','Fortune',null,null,null,null,2.9,4.0,'New launch',null,null],
  ['Navanaami One','Kokapet','Navanaami',null,null,null,null,2.0,2.8,'New launch',null,'Lowest-banded new launch found in Kokapet proper'],
  ['AVR Evania','Kokapet','AVR',null,null,null,null,2.9,3.2,'New launch',null,null],
  ['Elegantea Skyven','Kokapet','Elegantea',null,null,null,null,6.2,6.9,'New launch',null,null],
  ['MSN One','Kokapet','MSN',null,null,null,null,6.5,8.8,'New launch',null,null],
  ['Yula Globus Neo','Kokapet','Yula',null,null,null,null,2.5,5.1,'New launch',null,null],
  ['ASBL Spire','Kokapet','ASBL',393,1,35,null,1.81,2.12,null,null,null],
  ['Candeur Skyline','Kokapet','Candeur',null,null,null,'6520-11999 sqft (4 BHK)',null,null,'Launched',null,'On the Kokapet/Puppalaguda border; also listed under Narsingi by some sources'],
  ['Vasavi Savvy','Kokapet','Vasavi Group',null,null,null,null,null,null,null,null,null],
  ['Sumadhura Acropolis','Kokapet','Sumadhura',null,null,null,null,null,null,null,null,null],
  ['Sumadhura The Olympus','Kokapet','Sumadhura',null,null,null,null,null,null,null,null,null],
  ['Ramky One Odyssey','Kokapet','Ramky',null,3,36,null,null,null,'Upcoming',null,null],
  ['Cybercity Westbrook','Kokapet','Cybercity',null,null,null,null,null,null,null,null,null],
  ['Vertex Panache','Kokapet','Vertex Homes',null,null,null,null,null,null,null,null,null],
  ['SAS Crown','Kokapet','SAS Infra',null,5,57,'6565-8811 sqft',9.52,null,'Under construction',null,null],
  ['Incor One City','Kokapet','Incor',null,null,null,null,null,null,'2/3 BHK',null,null],

  // ── Kokapet Neopolis ───────────────────────────────────────────────────────
  ['My Home Nishada','Kokapet Neopolis','My Home Constructions',1398,8,44,'3450-4617 sqft',null,null,'Under construction (possession Dec 2026; one source says Apr 2028)','P02400004696','Possession date conflicts between sources'],
  ['My Home Grava','Kokapet Neopolis','My Home Constructions (Hyma Developers)',1289,7,null,'4365-8640 sqft',null,null,'Under construction',null,null],
  ['Rajapushpa Skyra','Kokapet Neopolis','Rajapushpa Properties',777,3,null,'3140-5235 sqft',3.3,null,'New launch',null,null],
  ['Prestige Neopolis','Kokapet Neopolis','Prestige Group',null,null,null,null,null,null,null,null,null],
  ['Brigade Gateway Neopolis','Kokapet Neopolis','Brigade Group',594,null,57,'3065-9860 sqft',null,null,'Under construction (launched Jan 2025, foundation stage Sep 2025)','P02400009142','Tower count conflicts between sources (2 vs 3)'],
  ['Godrej Neopolis','Kokapet Neopolis','Godrej Properties',350,1,49,'3500-4000+ sqft',2.8,4.0,'New launch','P02400009227','POSSIBLE DUPLICATE of Godrej Madison Avenue - verify'],
  ['GHR The Cascades Neopolis','Kokapet Neopolis','GHR Infra',1200,6,null,'1819-14467 sqft',2.5,5.3,'New launch (launched Mar 2025, completion Mar 2030)','P02400009538',null],
  ['GHR Infra Neopolis','Kokapet Neopolis','GHR Infra',null,null,null,null,2.1,null,'Upcoming',null,null],
  ['Lakshmi Infra Neopolis','Kokapet Neopolis','Lakshmi Infra',null,null,null,'1400-2500 sqft',1.5,null,null,null,'Size range overlaps the 2000-2300 target'],
  ['Urbanblocks Realty Neopolis','Kokapet Neopolis','Urbanblocks Realty',null,null,null,null,1.2,null,'Upcoming (possession Aug 2026)',null,null],
  ['Rise with 9','Kokapet Neopolis',null,386,2,null,null,null,null,null,null,'Builder not identified'],
  ['APR Neopolis','Kokapet Neopolis','APR',null,null,null,'800-2000 sqft (2/3 BHK)',null,null,null,null,null],
  ['MSN Neopolis','Kokapet Neopolis','MSN',null,null,null,null,null,null,null,null,'Advertises a dedicated senior-citizen deck'],
  ['Brigade Neopolis','Kokapet Neopolis','Brigade Group',null,null,null,null,null,null,'Possession expected 2026',null,'Advertises a dedicated senior-citizen deck'],

  // ── Narsingi ───────────────────────────────────────────────────────────────
  ['Rajapushpa Provincia','Narsingi','Rajapushpa Properties',3498,11,39,'1370-2660 sqft (2/3 BHK)',null,null,'Phase 1 handed over; Phase 2 possession Jan 2027','P02400002487',null],
  ['Jayabheri The Peak','Narsingi','Jayabheri Group',null,null,null,'4905-5440 sqft (4 BHK)',null,null,'Under construction',null,null],
  ['Jayabheri The Summit','Narsingi','Jayabheri Group',null,null,null,null,null,null,null,null,null],
  ['Vasavi Atlantis','Narsingi','Vasavi Group',null,null,null,'3/4 BHK high-rise',null,null,'RERA approved (number unverified)',null,null],
  ['NCC Urban One','Narsingi','NCC Urban',1317,12,null,'1535-3380 sqft (3/4 BHK)',null,null,'Township on 32 acres',null,'Size range overlaps the 2000-2300 target'],
  ['Sri Aditya Vantage','Narsingi','Sri Aditya',null,null,null,'4/5 BHK',null,null,null,null,null],
  ['Rajapushpa Imperia','Narsingi','Rajapushpa Properties',null,null,null,null,null,null,null,null,'Listed as Narsingi/Puppalaguda border'],

  // ── Puppalaguda ────────────────────────────────────────────────────────────
  ['My Home Avatar','Puppalaguda','My Home Constructions',2800,10,null,'1180-2100 sqft (2/3 BHK)',null,null,'Completed Sep 2019','P02400000002','Census confirms completion Sep 2019 and RERA number'],
  ['EIPL Skyila','Puppalaguda / Manikonda','EIPL Group',180,null,14,'1320-2190 sqft (2/3 BHK)',null,null,'Completed 2018 (resale market active)',null,null],
  ['Sumadhura Palais Royale','Puppalaguda','Sumadhura',null,null,null,'3/4 BHK',4.83,8.32,null,null,null],

  // ── Gandipet ───────────────────────────────────────────────────────────────
  ['EIPL Apila','Gandipet','EIPL Group',null,null,null,'1395-2240 sqft (2/3 BHK)',null,null,'Under construction / new','P02400000147','Size range overlaps the 2000-2300 target'],
  ['Alekhya Rise','Gandipet','Alekhya Homes',null,null,null,null,null,null,null,null,null],

  // ── Financial District ─────────────────────────────────────────────────────
  ['Prestige High Fields','Financial District','Prestige Estates',null,null,null,'1283-2729 sqft',0.61,5.23,'Ready to move / ongoing phases',null,'~Rs 11,999/sqft. Size range overlaps the 2000-2300 target. Also listed under Nanakramguda'],
  ['ASBL Spectra','Financial District','ASBL (Ashoka Builders)',null,null,null,null,1.99,2.15,'Ready to move',null,'~Rs 9,595/sqft - one of the lowest rates found in the corridor. A second source quotes Rs 2.25-2.50 Cr for 3 BHK'],
  ['ASBL Loft','Financial District','ASBL',null,null,null,'1695-1870 sqft',1.44,1.99,'Under construction',null,'Also listed under Nanakramguda'],
  ['ASBL Broadway','Financial District','ASBL',null,null,null,null,2.17,2.83,'Under construction',null,'~Rs 15,700/sqft'],
  ['Rajapushpa Eterna','Financial District','Rajapushpa Properties',null,null,null,null,1.57,4.19,'Ready to move',null,'~Rs 18,900/sqft - highest rate found in the corridor'],
  ['Amaris','Financial District','Kurra Infra',null,null,null,null,7.16,10.92,'Under construction',null,null],
  ['Aurum','Financial District','Sree Varaaha Group',null,null,null,null,2.85,4.41,'Under construction',null,null],
  ['Myscape Songs of the Sun','Financial District','Myscape Properties',null,null,null,null,2.83,3.48,'Under construction',null,'~Rs 17,300/sqft'],
  ['Aparna Zenon','Financial District','Aparna Constructions',null,null,null,null,2.14,3.50,'Under construction',null,'~Rs 10,751/sqft'],
  ['Aparna Cyberscape','Financial District','Aparna Constructions',null,null,null,null,null,null,'Delivery concerns flagged',null,'RED FLAG: delivery timeline flagged by residents and a graveyard-adjacency controversy reported. Verify on site before considering'],
  ['Lumbini Elysee','Financial District','Lumbini Constructions',null,null,null,'1328-2595 sqft',2.38,4.78,'Under construction / ongoing',null,'~Rs 24,100/sqft. Also listed as simply "Elysee" under Nanakramguda - same project, locality label varies by source'],
  ['Phoenix Aquila','Financial District','Phoenix Group',null,null,null,null,null,null,null,null,null],
  ['Phoenix Golf Edge','Financial District / Gachibowli','Phoenix Group',487,null,30,null,1.75,null,'Ready to move',null,null],
  ['Vasavi Sky City','Financial District / Gachibowli','Vasavi Group',null,2,19,null,null,null,null,'P02400000308',null],

  // ── Nanakramguda ───────────────────────────────────────────────────────────
  ['Destino','Nanakramguda','Sunshine Projects',null,null,null,'1578-3570 sqft',1.53,3.46,'Upcoming',null,'Size range overlaps the 2000-2300 target'],
  ['Western Springs','Nanakramguda','Western Constructions',null,null,null,'2185-3490 sqft',2.08,3.41,'Upcoming',null,'Size range starts inside the 2000-2300 target and the band starts near budget - worth pricing'],
  ['Trendset Winz','Nanakramguda','Trendset Builders',null,null,null,'2235-2525 sqft',null,null,'Ready to move',null,'Size range sits inside the 2000-2300 target and it is ready to move - worth pricing'],
  ['Alekhya Palm Woods','Nanakramguda','Alekhya Homes',null,null,null,'1735 sqft',2.40,null,'Ready to move',null,'~2 acres. Single size listed'],
  ['Jayabheri Temple Tree','Nanakramguda','Jayabheri Properties',null,null,null,'5090-11120 sqft',null,null,'Ongoing',null,null],
  ['Manbhum Signature','Nanakramguda','Manbhum Construction',12,null,3,'1300 sqft',null,null,'Ready to move',null,'Only 12 flats over 3 floors - low-rise, minimal lift dependency'],
  ['Manbhum Spring Leaf','Nanakramguda','Manbhum Construction',null,null,null,null,null,null,'Ready to move',null,null],
  ['Theme Golf View','Nanakramguda','Theme Ambience Infrastructures',null,null,null,'1130-2050 sqft',0.61,1.11,'Ready to move',null,'Lowest price band found anywhere in the corridor'],
  ['Shriya Serenity','Nanakramguda',null,null,null,null,null,null,null,null,null,'Builder not identified - name only'],

  // ── Gachibowli ─────────────────────────────────────────────────────────────
  ['My Home Vihanga','Gachibowli','My Home Constructions',1996,null,null,'1115-2160 sqft',null,null,null,null,'21-acre project. Size range overlaps the 2000-2300 target'],
  ['My Home Navadweepa','Gachibowli','My Home Constructions',556,null,null,null,null,null,null,null,'9.5 acres, 10,75,783 sqft built-up'],
  ['My Home Krishe','Gachibowli','My Home Constructions',null,4,26,'2/3 BHK',null,null,null,null,null],
  ['My Home Abhra','Gachibowli','My Home Constructions',387,null,null,'2/3 BHK',null,null,null,null,'Near Inorbit Mall - locality boundary between Gachibowli and Madhapur is uncertain'],
  ['Aparna Sarovar Zenith','Nallagandla','Aparna Constructions',2475,null,null,'2/3/4 BHK',null,null,null,null,'24 acres. Nallagandla, outside the two target areas - included for completeness'],
  ['Salarpuria Sattva Neopolis','Kokapet Neopolis','Salarpuria Sattva',null,null,null,'2/3/4 BHK',null,null,null,null,null],
];

const ROWS = RAW.map(r => ({
  project_name: r[0], locality: r[1], city: 'Hyderabad', builder: r[2],
  maps_url: gmap(r[0] + ' ' + r[1]),
  total_units: r[3], total_towers: r[4], floors_per_tower: r[5], size_range: r[6],
  price_min: cr(r[7]), price_max: cr(r[8]),
  project_status: r[9],
  notes: [r[10] ? 'RERA ' + r[10] : null, r[11]].filter(Boolean).join('. ') || null,
}));

const COLS = ['project_name','locality','city','builder','maps_url','total_units','total_towers',
  'floors_per_tower','size_range','price_min','price_max','project_status','notes'];

const user = db.prepare('SELECT id, email FROM users WHERE lower(email) = lower(?)').get(email);
if (!user) { console.error('No user found for ' + email); process.exit(1); }
console.log('Target user: #' + user.id + ' ' + user.email);
console.log('Mode: ' + (dry ? 'DRY RUN' : 'WRITE') + '  (merge: existing rows only get NULL columns filled)\n');

const find = db.prepare('SELECT * FROM property_shortlist WHERE user_id = ? AND project_name = ?');
const ins = db.prepare('INSERT INTO property_shortlist (user_id,' + COLS.join(',') + ',researched_at) VALUES (?,'
  + COLS.map(() => '?').join(',') + ',CURRENT_TIMESTAMP)');

let inserted = 0, merged = 0, untouched = 0;

const apply = db.transaction(() => {
  for (const r of ROWS) {
    const existing = find.get(user.id, r.project_name);
    if (!existing) {
      if (!dry) ins.run(user.id, ...COLS.map(c => r[c] === undefined ? null : r[c]));
      inserted++;
      console.log('  [insert] ' + r.project_name + '  (' + r.locality + ')');
      continue;
    }
    // Fill only what is NULL on the existing row.
    const fill = COLS.filter(c => c !== 'project_name'
      && (existing[c] === null || existing[c] === undefined)
      && r[c] !== null && r[c] !== undefined);
    if (!fill.length) { untouched++; console.log('  [same]   ' + r.project_name + '  (nothing new)'); continue; }
    if (!dry) {
      db.prepare('UPDATE property_shortlist SET ' + fill.map(c => c + '=?').join(',')
        + ', researched_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(...fill.map(c => r[c]), existing.id);
    }
    merged++;
    console.log('  [merge]  #' + existing.id + ' ' + r.project_name + '  +' + fill.join(',+'));
  }
  if (dry) throw new Error('__DRY__');
});

try { apply(); } catch (e) { if (e.message !== '__DRY__') throw e; }

console.log('\n' + (dry ? 'DRY RUN - nothing written. ' : 'Done. ')
  + 'insert=' + inserted + '  merge=' + merged + '  unchanged=' + untouched
  + '  (total candidate rows: ' + ROWS.length + ')');
