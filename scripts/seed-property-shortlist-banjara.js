#!/usr/bin/env node
// Seeds the Banjara Hills leg of the property search into property_shortlist.
//
// This is a CENSUS, not a filtered shortlist: no size or price gate is applied,
// because the filtering now happens on the page. Small boutique buildings sit
// alongside large towers deliberately.
//
// Data honesty rules followed here:
//   - Every field is either sourced or left null. Nothing is inferred to fill a gap.
//   - ask_price is null everywhere: these are project-level price bands, not live
//     unit listings. Portals (NoBroker/99acres/Housing) are JS-rendered and cannot
//     be read programmatically, so per-unit asks must be entered by hand.
//   - notes carries the provenance and any conflict found between sources.
//
// Usage: node scripts/seed-property-shortlist-banjara.js --email <address> [--dry]

const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db', 'database'));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}
const email = arg('--email');
const dry = process.argv.includes('--dry');
if (!email) {
  console.error('--email <address> is required');
  process.exit(1);
}

const gmap = q => 'https://www.google.com/maps/search/' + encodeURIComponent(q);

const ROWS = [
  {
    project_name: 'Fortune One',
    locality: 'Banjara Hills Road 12', city: 'Hyderabad',
    builder: 'Sri Sreenivasa Infra',
    address: 'Road No. 12, Banjara Hills, Hyderabad 500034',
    maps_url: gmap('Fortune One Banjara Hills Road 12 Hyderabad'),
    project_url: 'https://srisreenivasa.com/project/fortune-one/',
    size_sqft: null, facing: null, floor: null, bhk: 3, ask_price: null,
    project_status: 'Ready to move (completed ~Aug 2023)',
    total_units: 174, total_towers: 4, floors_per_tower: 10,
    size_range: '2355-4015 sqft (3/4 BHK)',
    car_parks: 3,
    maintenance_per_sqft: null,
    senior_fit_score: null,
    notes: 'RERA P02500001139. Stilt + 10 floors, 2 basements, ~3.3 acres. '
         + 'Price band ~Rs 10,000-14,000/sqft => roughly Rs 3.35-3.97 Cr. '
         + 'Best structural match on Rd 12 (100+ units, ready, 3 car parks, floors 4-10 '
         + 'available) but smallest unit is above the 2300 sqft ceiling and ~Rs 1 Cr over '
         + 'an all-in Rs 2.3 Cr budget.',
  },
  {
    project_name: 'The Valencia',
    locality: 'Banjara Hills Road 12', city: 'Hyderabad',
    builder: 'Dream India Group / FIMA Properties',
    address: 'Road No. 12, Mithali Nagar, Banjara Hills, Hyderabad 500034',
    maps_url: gmap('The Valencia Banjara Hills Road 12 Hyderabad'),
    project_url: 'https://dreamindiagroup.com/the-valencia/',
    size_sqft: null, facing: null, floor: null, bhk: 3, ask_price: null,
    project_status: 'CONFLICTING - builder site says ongoing, agents list ready to move',
    total_units: 120, total_towers: 14, floors_per_tower: null,
    size_range: '2423-4340 sqft (3/4 BHK)',
    car_parks: null,
    senior_fit_score: null,
    notes: 'Marketed via Subishi/Honeyy Group. Indicative ~Rs 12,000/sqft (unverified) '
         + '=> Rs 2.9 Cr+ for the smallest unit. Possession status must be confirmed on '
         + 'site: the builder\'s own page and resale listings disagree.',
  },
  {
    project_name: 'Amrutha Valley',
    locality: 'Banjara Hills Road 12', city: 'Hyderabad',
    builder: null,
    address: 'Road No. 12, Bhola Nagar, Banjara Hills, Hyderabad 500034 (beside Century Hospital)',
    maps_url: gmap('Amrutha Valley Apartments Banjara Hills Road 12 Hyderabad'),
    project_url: null,
    size_sqft: null, facing: null, floor: null, bhk: 3, ask_price: null,
    project_status: 'Ready (established, active rental and resale market)',
    total_units: 387, total_towers: null, floors_per_tower: null,
    size_range: '920-1500 sqft (2/3 BHK)',
    car_parks: null,
    senior_fit_score: null,
    notes: 'Largest unit count found on Road No. 12 (387 units, ~10.75 acres). '
         + 'NOT RERA registered - older stock. Beside Century Hospital, which is a '
         + 'genuine senior-access advantage. Units top out at 1500 sqft, well below '
         + 'the 2000-2300 sqft target, so included for completeness rather than fit.',
  },
  {
    project_name: 'Imaarat Golden Sands II',
    locality: 'Banjara Hills Road 12', city: 'Hyderabad',
    builder: 'Imaarat',
    address: 'Plot 60/A, Road No. 12, MLA Colony, Banjara Hills, Hyderabad 500034',
    maps_url: gmap('Imaarat Golden Sands MLA Colony Road 12 Banjara Hills Hyderabad'),
    project_url: null,
    size_sqft: null, facing: null, floor: null, bhk: 3, ask_price: null,
    project_status: 'unverified',
    total_units: null, total_towers: null, floors_per_tower: null,
    size_range: '2479-4622 sqft (3/4 BHK)',
    car_parks: null,
    senior_fit_score: null,
    notes: 'MLA Colony, Road No. 12. Unit count and possession status not sourced. '
         + 'Size range clears the 2000-2300 target from above.',
  },
  {
    project_name: 'Fortune Enclave',
    locality: 'Banjara Hills Road 12', city: 'Hyderabad',
    builder: 'DSR Infra',
    address: 'Road No. 12, Banjara Hills, Hyderabad 500034',
    maps_url: gmap('Fortune Enclave Banjara Hills Road 12 Hyderabad'),
    project_url: 'https://www.dsrinfra.com/property/fortune-enclave/',
    size_sqft: null, facing: null, floor: null, bhk: 3, ask_price: null,
    project_status: 'Ready',
    total_units: 62, total_towers: 6, floors_per_tower: 4,
    size_range: 'unverified',
    car_parks: null,
    senior_fit_score: null,
    notes: '6 blocks x 4 floors on ~4 acres. Below the 100-unit community threshold, '
         + 'but low-rise, which is worth noting for lift-dependency reasons.',
  },
  {
    project_name: 'Trendset Marigold',
    locality: 'Banjara Hills', city: 'Hyderabad',
    builder: 'Trendset Builders',
    address: 'Banjara Hills, Hyderabad 500034 (road number unverified)',
    maps_url: gmap('Trendset Marigold Banjara Hills Hyderabad'),
    project_url: null,
    size_sqft: null, facing: null, floor: null, bhk: 3, ask_price: null,
    project_status: 'unverified',
    total_units: null, total_towers: null, floors_per_tower: null,
    size_range: '3346-4467 sqft (3/4 BHK)',
    car_parks: null,
    senior_fit_score: null,
    notes: 'RERA P02500006589. Quoted Rs 5.19-6.92 Cr - far above budget, included for '
         + 'market context. Exact road number not sourced.',
  },
  {
    project_name: 'Woods Banjara Hills',
    locality: 'Banjara Hills', city: 'Hyderabad',
    builder: 'Stonecraft Group',
    address: 'Banjara Hills, Hyderabad 500034 (road number unverified)',
    maps_url: gmap('Woods Banjara Hills Stonecraft Hyderabad'),
    project_url: 'https://stonecraftgroup.com/woods-banjara-hills/',
    size_sqft: null, facing: null, floor: null, bhk: 3, ask_price: null,
    project_status: 'unverified',
    total_units: null, total_towers: null, floors_per_tower: null,
    size_range: '3500-5000 sqft (3 BHK)',
    car_parks: null,
    senior_fit_score: null,
    notes: 'Fully gated, ultra-luxury. Sizes start well above the target band. '
         + 'Unit count and road number not sourced.',
  },
  {
    project_name: 'Dukes Galaxy',
    locality: 'Banjara Hills Road 13', city: 'Hyderabad',
    builder: null,
    address: 'Road No. 13, Banjara Hills, Hyderabad 500034 (one source says Rd 14)',
    maps_url: gmap('Dukes Galaxy Banjara Hills Hyderabad'),
    project_url: null,
    size_sqft: 2185, facing: null, floor: null, bhk: 3, ask_price: 27500000,
    project_status: 'Ready (resale)',
    total_units: 65, total_towers: null, floors_per_tower: null,
    size_range: '~2185 sqft (3 BHK)',
    car_parks: null,
    senior_fit_score: null,
    notes: 'A resale at Rs 2.75 Cr for 2185 sqft was seen listed - the closest thing to '
         + 'the target size and budget found anywhere in Banjara Hills, though still over '
         + 'an all-in Rs 2.3 Cr. Road number disputed between sources (13 vs 14). '
         + 'Older stock. ask_price here is ONE observed listing, not a project rate.',
  },
  {
    project_name: 'Trendset Inspiria',
    locality: 'Banjara Hills Road 13', city: 'Hyderabad',
    builder: 'Trendset Builders',
    address: 'Road No. 13, Banjara Hills, Hyderabad 500034',
    maps_url: gmap('Trendset Inspiria Banjara Hills Road 13 Hyderabad'),
    project_url: null,
    size_sqft: null, facing: null, floor: null, bhk: 3, ask_price: null,
    project_status: 'unverified',
    total_units: 30, total_towers: 6, floors_per_tower: null,
    size_range: 'unverified (luxury 3 BHK)',
    car_parks: null,
    senior_fit_score: null,
    notes: 'Small boutique project - 30 units across 6 blocks. Well below the 100-unit '
         + 'community threshold.',
  },
];

const user = db.prepare('SELECT id, email FROM users WHERE lower(email) = lower(?)').get(email);
if (!user) {
  console.error('No user found for ' + email);
  process.exit(1);
}
console.log('Target user: #' + user.id + ' ' + user.email);
console.log('Mode: ' + (dry ? 'DRY RUN' : 'WRITE') + '\n');

if (dry) {
  for (const r of ROWS) {
    console.log('  ' + r.project_name + ' - ' + r.locality + ' - ' + (r.size_range || '?')
      + ' - ' + (r.total_units != null ? r.total_units + ' units' : 'units unverified'));
  }
  console.log('\n' + ROWS.length + ' rows (dry run, nothing written).');
  process.exit(0);
}

const COLS = ['project_name','locality','city','builder','address','maps_url','project_url',
  'size_sqft','facing','floor','bhk','ask_price','project_status','total_units','total_towers',
  'floors_per_tower','size_range','car_parks','maintenance_per_sqft','senior_fit_score','notes'];

const find = db.prepare('SELECT id FROM property_shortlist WHERE user_id = ? AND project_name = ? AND locality IS ?');
const ins = db.prepare('INSERT INTO property_shortlist (user_id,' + COLS.join(',') + ',researched_at) '
  + 'VALUES (?,' + COLS.map(() => '?').join(',') + ',CURRENT_TIMESTAMP)');
const upd = db.prepare('UPDATE property_shortlist SET ' + COLS.map(c => c + '=?').join(',')
  + ', researched_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?');

let inserted = 0, updated = 0;
const run = db.transaction(() => {
  for (const r of ROWS) {
    const vals = COLS.map(c => (r[c] === undefined ? null : r[c]));
    const existing = find.get(user.id, r.project_name, r.locality);
    if (existing) { upd.run(...vals, existing.id); updated++; console.log('  [updated]  #' + existing.id + '  ' + r.project_name); }
    else { const res = ins.run(user.id, ...vals); inserted++; console.log('  [inserted] #' + res.lastInsertRowid + '  ' + r.project_name); }
  }
});
run();

console.log('\nDone. inserted=' + inserted + '  updated=' + updated);
