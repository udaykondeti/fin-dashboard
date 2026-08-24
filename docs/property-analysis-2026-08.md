# Property Cost-Benefit Analysis — Parents' Residence

**Date:** 2026-08-25
**Occupants:** Retired couple, ages 64 and 75 (per `property_shortlist` schema)
**Budget:** ₹2.3 Cr · **Down payment:** ₹1 Cr · **Loan:** ₹1.3 Cr
**Target areas:** (A) Kokapet / Narsingi / Financial District corridor, (B) Banjara Hills Road No. 12

---

## 1. Headline finding: the budget does not clear the size requirement

This is the single most important output of the analysis, so it goes first.

**₹2.3 Cr all-in does not buy 2,000–2,300 sqft ready-to-move in either target area at August 2026 rates.**

| Area | Realistic ready-to-move rate | 2,150 sqft base | All-in (incl. duties, corpus, parking) | Gap vs ₹2.3 Cr |
|---|---|---|---|---|
| Kokapet (resale / handed-over) | ₹12,200–15,800/sqft *(corrected — see §8)* | ₹2.62–3.40 Cr | **₹2.85–3.65 Cr** | −₹55 L to −₹1.35 Cr |
| Kokapet Neopolis (new inventory) | ₹13,500–17,000/sqft | ₹2.90–3.66 Cr | ₹3.15–3.95 Cr | −₹85 L to −₹1.65 Cr |
| Banjara Hills Rd 12 (luxury) | ₹15,000–18,000/sqft | ₹3.23–3.87 Cr | ₹3.50–4.20 Cr | −₹1.2 Cr to −₹1.9 Cr |
| Banjara Hills (older gated resale) | ₹11,000–13,000/sqft | ₹2.37–2.80 Cr | ₹2.60–3.05 Cr | −₹30 L to −₹75 L |

Corroborating evidence from the existing shortlist seed (already researched, `scripts/seed-property-shortlist-rajapushpa.js`):

- **Rajapushpa Provincia, 2,128 sqft — asking ₹3.05 Cr**
- **Rajapushpa Provincia, 1,868 sqft — asking ₹2.60 Cr**

Both are over budget, and the smaller one is *below* the size floor while still exceeding ₹2.3 Cr.

### What ₹2.3 Cr all-in actually buys

| Area | Realistic size at ₹2.3 Cr all-in |
|---|---|
| Kokapet / Narsingi | ~1,750–1,900 sqft |
| Puppalaguda / Manikonda | ~1,950–2,150 sqft ✅ *only area where the size target is reachable* |
| Banjara Hills Rd 12 | ~1,350–1,500 sqft |

**Three ways to resolve the gap** (decision required):

1. **Raise the budget to ~₹2.6–2.7 Cr** — keeps size and area, increases loan to ~₹1.6–1.7 Cr.
2. **Relax size to 1,800–2,000 sqft** — keeps ₹2.3 Cr and Kokapet. For two people this is still generous.
3. **Shift area to Puppalaguda / Manikonda / Narsingi-inner** — keeps both size and budget, trades prestige and a little infra quality.

---

## 2. Senior-suitability: the decisive axis

At 75, the binding constraints are **time-to-tertiary-hospital** and **walkability without a car**. These dominate per-sqft value.

### Healthcare proximity

| Location | Nearest tertiary care | Drive time (normal traffic) |
|---|---|---|
| **Banjara Hills Rd 12** | **Virinchi Hospital — on Road No. 12 itself** (Virinchi Circle, Rd 1/12 junction) | **2–4 min off-peak; materially worse at peak — see §8** |
| Banjara Hills Rd 12 | Care Hospital, Rd No. 1 | ~5 min |
| Banjara Hills Rd 12 | Century Hospital | ~5 min |
| Kokapet / Narsingi | Continental Hospitals, Financial District (~8.6 km) | **<10 min via ORR** *(corrected from 15–20)* |
| Kokapet / Narsingi | AIG Hospitals, Gachibowli (800-bed) | 12–20 min |
| Nanakramguda (Lansum Etania) | Yashoda — **<500 m, walkable** | walk |
| Kokapet | Medihub Clinics (local, 15 specialities — not tertiary) | ~5 min |

**Banjara Hills Rd 12 wins healthcare decisively.** A hospital with cardiology, neurology and nephrology at the end of the road is worth more to a 75-year-old than 300 extra sqft. For cardiac and stroke events the golden hour is the whole game, and 20 minutes of ORR traffic is a real risk premium.

The one Kokapet-corridor option that matches this is **Lansum Etania, Nanakramguda** — Yashoda under 500 m. That single fact is why it scores 85 in the existing seed.

### Walkability and daily living

| Factor | Banjara Hills Rd 12 | Kokapet / Neopolis |
|---|---|---|
| Footpaths | Established, continuous | Sparse; many stretches missing |
| Pharmacy on foot | Multiple, incl. Virinchi 24/7 in-house | Usually needs a car |
| Groceries on foot | Dense established retail | Mostly mall/car-dependent |
| Banks / ATMs | HDFC at Virinchi Circle; all majors within 1 km | ORR service road cluster, ~0.75 km |
| Construction dust / noise | Minimal — mature area | **Significant, ongoing for years** |
| Neighbourhood age mix | Established, multi-generational | Young IT professionals, transient |
| Metro | Khairatabad ~0.7 km (existing, operational) | **Phase 2 only — Corridor V not yet built** |

Construction dust deserves weight. Neopolis is an active build-out zone and will be for several more years. For a 75-year-old with any respiratory sensitivity, that is a daily quality-of-life cost, not a footnote.

### Floor selection

Your 4th–10th floor filter is sound, but I'd tighten it to **4th–6th** for this couple. Above the 6th, a lift outage during a power failure becomes a genuine trap rather than an inconvenience. Verify at site visit:

- Number of lifts **per tower** (not per project) — want ≥2, ideally 3
- **100% DG backup on lifts specifically**, not just common areas
- Lift dimensions — must take a stretcher flat
- Ramp gradient at lobby, and whether the ramp reaches the *lift*, not just the entrance

Note that two strong seeded candidates fail your floor filter: **Prestige Tranquil (15th)** and **Lansum Etania (18th)**. Worth asking those builders for lower-floor inventory rather than dropping them.

### Transport

- **Banjara Hills:** Khairatabad metro 0.7 km (operational today), dense bus routes, instant cab availability, Khairatabad railway station nearby.
- **Kokapet:** ORR access excellent for airport (~30 min to RGIA). Metro Corridor V (Raidurg → Kokapet Neopolis, 11.6 km) and the Airport Express via Narsingi are **Phase 2, not yet operational** — do not price them as present-day amenities. Cab availability at gates is good.

For a retired couple who will not be commuting, ORR access matters far less than footpaths and a nearby hospital. This further favours Banjara Hills.

---

## 3. Loan structure and EMI

### EMI on ₹1.3 Cr

Rates as of August 2026: lowest ~7.10% (PSU, CIBIL 800+), SBI 7.25–8.45%, HDFC from 7.75%, ICICI from 7.75%, Bajaj Housing from 7.25%. **Working assumption: 8.00%.**

| Tenure | EMI @ 8.00% | Total interest | Total outflow |
|---|---|---|---|
| 10 years | **₹1,57,700** | ₹59.3 L | ₹1.89 Cr |
| 15 years | **₹1,24,200** | ₹93.6 L | ₹2.24 Cr |
| 20 years | **₹1,08,700** | ₹1.31 Cr | ₹2.61 Cr |

Rate sensitivity on the 20-year option: each 0.25% moves the EMI by roughly ₹2,000/month and total interest by ~₹5 L. Negotiating 8.00% → 7.50% saves about **₹10 L** over the term — worth more than any fee waiver a bank will offer you.

The 15-year option is the sweet spot: ₹15,500/month more than 20 years, but **₹37 L less interest**.

### Who should borrow — this matters a lot

**Your father should not be the primary borrower.** Lender age caps at loan maturity:

| Lender | Max age to apply | Loan can run until |
|---|---|---|
| SBI | — | 75 (and pensioner loans cap around ₹14 L — not usable here) |
| PNB Housing Finance | 70 | 75 |
| **LIC Housing Finance** | **65** | **80** — best for defined-benefit govt pensioners |

If your father is the 75-year-old, he is **ineligible as primary borrower anywhere**, and even at 64 he'd be capped to roughly an 11-year tenure at LIC HF and would pay the senior-citizen rate band of **8.40–10.80%** rather than 7.75–8.15%.

**Recommended structure — REVISED after adversarial review (see §8.7):**

The original recommendation here was "Kiran as sole borrower, parent as day-one co-owner." **That is very likely not bankable.** Standard Indian lender practice (HDFC, ICICI, SBI) requires that **every co-owner must also be a co-borrower**. The reverse is allowed — a co-borrower need not own — but a co-owner cannot be left off the loan. As literally written, the plan would be rejected at underwriting by the very lenders recommended.

**The structurally sound version:**

1. **Buy solely in Kiran's name.** Salaried, full 15–20 year tenure, best rate band, no senior-citizen rate penalty, no compressed tenure.
2. **Close or substantially pay down the loan.**
3. **Then gift a co-ownership share to the parent** by registered gift deed. In Telangana a gift to a family member costs **2% stamp + 0.5% registration**, versus 6% for a sale — so this route is also materially cheaper than putting the parent on title at purchase.
4. **Execute a registered Will immediately** — see the succession warning below.
5. Father's central govt pension (dearness relief, lifelong, family pension continuing to your mother) is excellent *supporting* income if a lender wants comfort, but should not drive the structure.

**⚠️ Succession — the original draft had this exactly backwards.** India does **not** apply automatic survivorship to co-owned property; that is a common-law joint-tenancy concept that does not carry over. If a Hindu co-owner dies intestate, their share devolves under the **Hindu Succession Act 1956 to all Class-I heirs — the surviving spouse *and every child equally*.** A 75-year-old parent dying as co-owner without a Will therefore *fragments* title across siblings and clouds it, rather than passing cleanly. A registered Will is not optional here; it is the whole basis on which co-ownership is safe.

**Tax — with an important caveat the original draft missed:**

As owner you can treat the property as self-occupied even with parents residing there. The original draft dated this to AY 2020-21; that is wrong by five years — the unconditional two-self-occupied-property rule came in via **Finance Act 2025, effective AY 2025-26**. AY 2026-27 is safely past that cutover, so the conclusion holds today.

The trap: **the ₹2 L Section 24(b) cap is aggregated across ALL of an individual's self-occupied properties, not granted per property.** If you already own and occupy a home with its own housing loan, this ₹10.3 L of new interest does *not* get a fresh ₹2 L bucket — it shares the existing one, and the marginal benefit may be **zero**. The "~₹62,400/year at the 30% slab" figure holds only if you have no other self-occupied property already claiming interest. **Confirm before letting tax influence the decision.**

**Best approaches, in priority order:**

1. Get written offers from **at least four** lenders — spread across PSU, HDFC/ICICI, and Bajaj Housing. Rate dispersion is currently ~1.3%, which is enormous on ₹1.3 Cr.
2. Insist on **EBLR/repo-linked floating**, not MCLR or fixed. Repo-linked repricing is transparent and passes cuts through faster.
3. Confirm **zero prepayment penalty** — mandatory on floating loans for individuals, but get it in writing.
4. Pull your CIBIL before applying. Crossing 750, and ideally 800, is worth 0.25–0.50%.
5. Consider a **₹1.4–1.5 Cr sanction while drawing only ₹1.3 Cr**, giving headroom if the budget has to stretch to close the size gap.
6. Prepay aggressively in years 1–7 — that's when the amortisation is almost entirely interest.

---

## 4. Maintenance and carrying-cost projection

Basis: ₹3.75/sqft/month (the rate already recorded for Kokapet projects in the seed), 2,100 sqft, 7% annual escalation.

**GST trap:** maintenance above ₹7,500/month attracts 18% GST. At 2,100 sqft × ₹3.75 = ₹7,875/month, you cross it immediately — GST applies to the **whole** amount, not the excess.

**Both inputs above were too low — corrected after adversarial review (§8.8).** Kokapet-tier luxury projects run **₹4–6/sqft**, not ₹3.75, and realistic escalation is **8–10%/yr**, not 7%. Revised basis: **₹5/sqft, 2,100 sqft, 8% escalation.**

| Year | Monthly (incl. GST) | Annual |
|---|---|---|
| 1 | ₹12,390 | ₹1,48,700 |
| 5 | ₹16,860 | ₹2,02,300 |
| 10 | ₹24,770 | ₹2,97,200 |

**10-year cumulative maintenance: ≈ ₹21.5 L** (sensitivity at ₹4–6/sqft: **₹17.2 L – ₹25.8 L**)

This is **40% higher** than the original ₹15.4 L estimate, which understated the rate and the escalation simultaneously — compounding the error.

Add per year:
- **GHMC property tax:** ₹20,000–33,000 *(revised up — the original ₹15–25 K ceiling was too low for a 2,100 sqft high-value unit at the 30% slab + 8% library cess)*
- **Home insurance:** ₹8,000–12,000
- **Internal upkeep / repairs:** ₹25,000–40,000

**Realistic all-in carrying cost, year 1: ~₹2.2 L/year (₹18,000/month) on top of EMI** — up from the original ₹1.6 L estimate.

Recurring items the original draft omitted entirely, all of which bite in Kokapet specifically:
- **Water tanker charges** — material and seasonal; Kokapet has known borewell/municipal supply gaps
- **DG diesel surcharge**, metered per flat during summer outages
- **Sinking fund** — a separate ongoing surcharge, not the same thing as corpus
- **Periodic painting / repair levy** — special assessment every 5–7 years
- **EV charger installation** — rarely builder-included
- **Society transfer fee on resale** — typically 0.5–1%, or a flat ₹25 K–1 L

One-time at purchase, over and above the headline price:
- Stamp duty + registration + transfer duty (Telangana): **6%** → ~₹13.8 L on ₹2.3 Cr. **Caveat:** 2026 guidance values around the ORR (which includes Kokapet) were revised **up 30–50%**. Duty is charged on the higher of guidance or agreement value, so the effective bill can exceed a naive 6% × sale price.
- **Preferential Location Charges (PLC): ₹100–400/sqft → ₹2.1–8.4 L** on 2,100 sqft. Completely missing from the original draft. East/north-facing and mid-floor units — exactly your filter — are precisely what attracts PLC.
- **Club membership (one-time, non-refundable): ₹1.5–4.5 L.** One Rajapushpa project's clubhouse membership alone was cited at ₹4.5 L.
- Corpus / maintenance deposit: **₹1–2.5 L** (12–24 months of maintenance)
- Infrastructure / development charges: a separate line on several builder cost sheets
- Covered parking (2 slots, if charged separately): **₹4–10 L**
- GST: **nil** on ready-to-move with Occupancy Certificate — a real reason to prefer OC-received inventory over near-complete

**Corrected one-time extras (corpus + club + PLC): ₹5–15 L, not the ₹2–5 L originally stated.**

**This is why "₹2.3 Cr budget" needs defining as base price or all-in. If ₹2.3 Cr is all-in, the base price ceiling is roughly ₹2.05 Cr.**

---

## 5. Area verdict

| Criterion | Weight for this couple | Banjara Hills Rd 12 | Kokapet / Narsingi |
|---|---|---|---|
| Hospital access | Very high | ★★★★★ | ★★☆☆☆ (★★★★★ for Lansum Etania) |
| Walkability | Very high | ★★★★★ | ★★☆☆☆ |
| Air quality / noise | High | ★★★★☆ | ★★☆☆☆ (active construction) |
| Value per sqft | High | ★★☆☆☆ | ★★★★☆ |
| Modern amenities / lifts | Medium | ★★★☆☆ (older stock) | ★★★★★ |
| Capital appreciation | Medium | ★★★☆☆ (mature, stable) | ★★★★★ (+100% in 5 yrs) |
| Metro today | Medium | ★★★★☆ (Khairatabad 0.7 km) | ★☆☆☆☆ (Phase 2 pending) |
| Community for seniors | Medium | ★★★★☆ | ★★☆☆☆ (young, transient) |

**Recommendation:** For occupants aged 64 and 75, **Banjara Hills Road No. 12 is the better residence** and **Kokapet is the better investment**. These are genuinely different objectives and the choice depends on which one this purchase is actually for.

If it is primarily a home for your parents, accept fewer sqft in Banjara Hills. If it is primarily an asset that your parents occupy meanwhile, Kokapet wins — and then **Lansum Etania, Nanakramguda** is the standout, because Yashoda at <500 m closes Kokapet's single worst weakness. Its problem is the 18th floor, so ask about lower-floor resale inventory specifically.

---

## 6. Verified candidate set

Already enriched in the seed (Kokapet corridor):

| Project | Locality | Builder | Size | Units | Status | Senior score |
|---|---|---|---|---|---|---|
| **Lansum Etania** | Nanakramguda | Lansum | 2,165 sqft | 372 | Ready (2019) | **85** |
| My Home Avatar | Puppalaguda | My Home | 1,180–2,100 | 2,800 | Ready (~2020) | 80 |
| EIPL Skyila | Puppalaguda | EIPL | 1,320–2,190 | 180 | Ready (2018) | 72 |
| My Home Tarkshya | Kokapet | My Home | 1,956 sqft | 660 | Ready (2023) | 62 |
| Prestige Tranquil | Kokapet | Prestige | 2,049 sqft | 906 | Sep-2026 (not ready) | 55 |
| Rajapushpa Provincia | Narsingi | Rajapushpa | 2,128 sqft | 3,498 | Ph1 handed over | 55 |

Banjara Hills leads to pursue (project-level; **not verified live inventory**):

| Project | Road | Builder | Units | Size range | Price | Status | Parking |
|---|---|---|---|---|---|---|---|
| **Fortune One** | **Rd No. 12** | Sri Sreenivasa Infra (RERA P02500001139) | **174** | 2,355–4,015 sqft | ₹10,000–14,000/sqft → **₹3.35–3.97 Cr** | **Ready to move** (completed ~Aug 2023) | **3 per unit** |
| The Valencia | Rd No. 12, Mithali Nagar | Dream India Group / FIMA | 120 | 2,423–4,340 sqft | unverified (~₹12,000/sqft cited) | **Conflicting** — builder's site says ongoing, agents say ready | unverified |
| Fortune Enclave | Rd No. 12 | DSR Infra | 62 | — | — | — | Fails 100+ filter |
| Dukes Galaxy | Rd No. 13 (one source says 14) | — | 65 | 2,185 sqft | ₹2.75 Cr (a resale seen) | Ready | Fails 100+ filter, and not Rd 12 |
| Trendset Inspiria | Rd No. 13 | Trendset | 30 | — | — | — | Fails 100+ filter |

**Fortune One is the best structural match on Road No. 12 and I missed it in the first pass.** It clears every one of your filters except price: 174 units ✅, ready to move ✅, stilt + 10 floors so your 4th–10th band is available ✅, **3 car parks per unit** ✅ (you asked for 2+). Its problem is that the *smallest* unit is 2,355 sqft — just above your 2,300 ceiling — and it starts at ₹3.35 Cr, which is ₹1 Cr over budget.

Verified as **not** on Road No. 12 despite being commonly suggested: Aparna CyberZon (Nallagandla), My Home Jewel (Madinaguda), Lodha Bellezza (Hitec City), SMR Vinay (Bandlaguda Jagir), Phoenix (Jubilee Hills), Kaveri Heights (Mumbai — pure name collision). Roads 10, 11 and 14 yielded no named 100+ unit development at all.

**Road No. 12 is mixed-density, not bungalow-exclusive** — where large contiguous plots exist (2.5–3.3 acres), 100+ unit towers do get built. But only two such projects exist on the road, and **both start above your size ceiling and roughly ₹1 Cr above budget.** The binding constraint on Road No. 12 is not the 100+ unit filter; it is price.

---

## 7. Open items

Ranked by how much each one moves the answer:

1. **Is "2,000–2,300 sqft" super built-up or carpet area?** *(new — §8.5)* Hyderabad loading runs 30–38%, up to 60%. A 2,150 sqft SBA unit is roughly 1,400 sqft carpet. If you meant livable area, every price figure in this document needs re-basing and the budget gap widens sharply. **Biggest single unknown.**
2. **Is ₹2.3 Cr base price or all-in?** With duties at 6%, PLC at ₹2.1–8.4 L, and club membership at ₹1.5–4.5 L, the difference is now closer to **₹30–40 L** of shoppable ceiling than the ₹25 L originally estimated.
3. **Do you already own a self-occupied home with a running housing loan?** *(new — §8.7)* If yes, the ₹2 L §24(b) benefit may be **zero**, and tax should drop out of the decision entirely.
4. **Which objective dominates — residence or investment?** Decides area. See §5 and the adjudication at the end of §8.
5. **Which parent is 75 and which is 64** — determines co-applicant viability if the gift-deed route is rejected.
6. **Father's monthly pension** — needed only if a lender wants supporting income.
7. Site visits must verify: lifts per tower, DG backup on lifts specifically, stretcher-capable lift dimensions, ramp reaching the *lift lobby* not just the entrance, and whether 2 covered parking slots are included or charged.

## 8. Adversarial review — round 1 corrections

Six agents were run against this document with instructions to attack it. Three have reported. Their corrections are recorded here rather than silently folded in, so the reasoning stays auditable.

### Corrections that change conclusions

**8.1 — Kokapet resale is more expensive than §1 originally stated.** Registered-transaction data puts Kokapet-core at **₹12,200–15,800/sqft**, not the ₹10,000–12,500 originally used. This makes the budget-gap conclusion *stronger*, not weaker. §1 table corrected.

**8.2 — The §1 headline overclaimed on "Narsingi".** Puppalaguda / Manikonda — which many listings label as Narsingi — genuinely clears the budget at the target size: ₹8,900–10,500/sqft blended, giving **₹1.95–2.30 Cr all-in for 2,000 sqft**. The original headline implied the whole Narsingi corridor fails, when in fact the adjacent submarket is the answer rather than an exception. Note the asking-vs-closing gap: Puppalaguda asks ₹10,000–12,200/sqft but government-registered transactions average **~₹7,300/sqft**, implying real negotiating room. No specific under-budget unit at 2,000–2,300 sqft in a named 100+ unit community could be verified, so this is headroom, not a found listing.

**8.3 — Kokapet's hospital access is better than §2 stated.** Continental is ~8.6 km, **under 10 minutes via ORR** in normal conditions, not 15–20. AIG is 12–20 min. §2 corrected.

**8.4 — Banjara Hills Rd 12 has a documented ambulance problem.** Both the Rd 12 advocate *and* the Kokapet advocate independently surfaced this. Relocated U-turns have created a chokepoint on the Bhavani Nagar–Virinchi stretch; a nurse quoted in Deccan Chronicle described "the plight of ambulances due to waiting time at this new U-turn." Rd 12 is a 3.2 km daily bottleneck at peak. **The "hospital at the end of the road" advantage is real off-peak and substantially degraded at peak.** This is the single biggest qualification to §5's recommendation. It is, however, a fixable traffic-engineering fault rather than a structural feature of the location.

**8.5 — NEW RISK, not previously in scope: carpet vs super built-up.** Hyderabad loading factors run **30–38%, and up to 60%** on some projects. If "2,000–2,300 sqft" is meant as *livable* area rather than quoted SBA, every price-per-sqft figure in this document needs re-basing and the budget gap widens dramatically. **This needs an explicit answer before any site visit.** A 2,150 sqft SBA unit at 35% loading is roughly 1,400 sqft carpet.

### Claims that survived attack

- **Telangana stamp duty 6% — confirmed.** 4% stamp + 1.5% transfer + 0.5% registration.
- **GST nil on OC-received ready-to-move — confirmed.** Post-OC transfers fall under Schedule III, outside GST scope.
- **Yashoda <500 m from Lansum Etania — independently corroborated.** Yashoda's registered address is literally "Behind Lansum Etania Apartments Complex, Financial District, Nanakramguda."
- **Virinchi is genuinely tertiary-grade** — 500 beds, 140 ICU beds, 11 OTs, two cardiac cath labs, 3T fMRI/PET-CT. Not a boutique clinic. Backed by Care Rd 1 (435 beds), Century (220 beds), Star Rd 10 — three-to-four-deep tertiary redundancy within ~5 min.

### New evidence added

- **Air quality is measurable:** Banjara Hills AQI 158 vs Kokapet 186, spiking to 218. Both unhealthy; the gap is real.
- **Pension logistics (previously missed):** Virinchi sits opposite the Pension Office, with an HDFC branch beside it running Jeevan Pramaan / govt pension disbursement. Apollo Pharmacy is on Rd 12; HDFC has a dedicated Rd 12 branch. For a central-govt pensioner the life-certificate errand and cardiology follow-up become one trip.
- **New-build senior spec is a genuine differentiator:** stretcher-capable lifts, senior-gradient ramps reaching the lift lobby, panic buzzers. MSN Neopolis and Brigade Neopolis advertise senior-citizen decks; Rajapushpa Casa Luxura has a senior lounge. Retrofitting a stretcher-width lift into a 20-year-old Banjara Hills shaft is often physically impossible — a real structural argument for new construction.
- **Exit liquidity cuts both ways:** Kokapet has appreciated ~100% in 5 years with HMDA Neopolis Phase 3 land bid at ₹151.25 Cr/acre against a ₹99 Cr upset price. But Banjara Hills has the deeper, more liquid resale pool if funds are needed *urgently* for medical costs.
- **Domestic help / nursing attendants:** roughly equal availability in both corridors. Not a differentiator.

### Round 1 complete — remaining corrections

**8.6 — EMI arithmetic verified correct.** Independently recomputed at 8.00% on ₹1.30 Cr: 10y ₹1,57,726 · 15y ₹1,24,235 · 20y ₹1,08,737, with total interest ₹59.27 L / ₹93.62 L / ₹1.310 Cr. All three match §3 to the nearest ₹100. No correction needed.

**8.7 — The borrowing structure was the weakest part of the document.** Three separate defects, all now fixed in §3:
- "Co-owner but not co-borrower" is **likely not bankable** — lenders require all co-owners to be co-borrowers. The gift-deed-after-closure route is the only structurally sound version.
- **Succession was stated backwards.** No automatic survivorship in India; intestate death of a co-owner fragments the share across all Class-I heirs. A registered Will is mandatory, not advisable.
- **The ₹2 L §24(b) cap is aggregate, not per-property.** If Kiran already has a self-occupied home with a loan, the tax benefit may be zero.
- Minor: the two-SOP rule dates to Finance Act 2025 (AY 2025-26), not AY 2020-21. Conclusion unaffected for AY 2026-27.
- Rates slightly stale: ICICI now from **7.50%** (not 7.75%), Bajaj Housing from **7.15%** (not 7.25%). LIC HF Griha Varishtha to age 80 for pensioners — confirmed.

**8.8 — Carrying costs were understated by roughly 40%.** Rate ₹4–6/sqft not ₹3.75; escalation 8–10% not 7%; **10-year maintenance ≈ ₹21.5 L, not ₹15.4 L**. GHMC tax revised to ₹20–33 K/yr. Year-1 all-in carrying cost now ~₹2.2 L, not ₹1.6 L. Six recurring cost categories were missing entirely (water tankers, DG diesel surcharge, sinking fund, painting levy, EV charger, resale transfer fee).

**8.9 — The single largest one-time omission: PLC.** Preferential Location Charges run ₹100–400/sqft — **₹2.1–8.4 L** on a 2,100 sqft unit — and are levied precisely on east/north-facing, mid-floor units, which is exactly your filter. Club membership adds ₹1.5–4.5 L one-time. Corrected one-time extras: **₹5–15 L, not ₹2–5 L**.

**8.10 — GST on maintenance is a two-condition test.** The ₹7,500/member/month threshold is correct, and GST does apply to the whole amount once crossed (affirmed by Madras HC). But it *also* requires the RWA's aggregate annual turnover to exceed ₹20 L. In a large Kokapet project both conditions are met immediately, so this is not an escape hatch — but §4 should state it as a condition rather than omit it.

**8.11 — Stamp duty has a guidance-value trap.** 2026 guidance values around the ORR, including Kokapet, were revised **up 30–50%**. Duty is charged on the higher of guidance or agreement value, so the effective bill can exceed a naive 6% × sale price.

**8.12 — "The Valencia is the only 100+ unit project on Rd 12" was false.** **Fortune One** (174 units, RERA P02500001139, ready to move, 3 car parks per unit, stilt + 10 floors) is on Road No. 12 and is a better structural match than Valencia on every filter except price. See §6.

### Where the two area advocates actually disagreed

Both were asked to argue opposite sides. They converged on one thing and split on another:

- **Converged:** the Rd 12 ambulance/traffic problem is real and documented. Neither side disputed it.
- **Split:** the Kokapet advocate argued a free-flowing 10-minute ORR run may genuinely beat a jammed 500 m crawl on Rd 12. The Rd 12 advocate countered that congestion is a fixable traffic-engineering fault, not a structural property of the location, whereas 8.6 km is permanent.

**Adjudication:** the Rd 12 advocate is right in principle but the Kokapet advocate is right in practice. You cannot buy on the assumption that GHMC fixes a U-turn. Rd 12 retains the edge — three-to-four-deep tertiary redundancy within 5 minutes still beats two hospitals at 10–20 minutes, and the pension-office adjacency is a genuine daily-life advantage — but the margin is much narrower than §5 originally claimed, and it is now a judgement call rather than an obvious win.

## 9. Parameters resolved — revised verdict

The three open questions from §7 are answered: **(1) sizes are super built-up, (2) ₹2.3 Cr is all-in, (3) no existing home loan.** This sharpens the conclusion considerably.

### 9.1 All-in changes the shoppable ceiling to ~₹2.0 Cr

Working backwards from ₹2.3 Cr all-in, with 6% duty plus the one-time extras identified in §8.9:

| Extras scenario | PLC + club + corpus + parking | Base price ceiling |
|---|---|---|
| Low (parking included, minimal PLC) | ₹8.6 L | **₹2.09 Cr** |
| High (2 slots charged, corner/east PLC) | ₹25.4 L | **₹1.93 Cr** |

**Base price ceiling: ₹1.93–2.09 Cr.** Not ₹2.3 Cr, and not the ₹2.05 Cr first estimated — PLC and club membership pull it lower.

### 9.2 What that buys, by submarket

| Submarket | Rate (₹/sqft) | Size at ₹1.93–2.09 Cr base | Verdict |
|---|---|---|---|
| **Puppalaguda / Manikonda / Narsingi-fringe** | 8,900–10,500 | **1,838–2,348 sqft** | ✅ **Only submarket that reaches the target band** |
| Kokapet-core | 12,200–15,800 | 1,222–1,713 sqft | ❌ Short by 300–800 sqft |
| Banjara Hills Rd 12 | 15,000–18,000 | 1,072–1,393 sqft | ❌ Short by 600–900 sqft |

**Banjara Hills Road No. 12 is now definitively out at this budget.** Both verified 100+ unit projects there — Fortune One (from ₹3.35 Cr) and The Valencia (from ~₹2.9 Cr) — start roughly ₹1–1.6 Cr above an all-in ₹2.3 Cr. This is no longer a trade-off between space and healthcare access; it is simply unaffordable. Recommending it would be recommending something you cannot buy.

The §5 "better residence vs better investment" framing therefore collapses: **the decision is now which project within Puppalaguda / Manikonda**, unless the budget moves.

### 9.3 SBA confirmed — a livability note, not a pricing problem

Because sizes are super built-up, every rate in this document is correctly based and nothing needs re-basing. But at Hyderabad's typical 30–38% loading, **a 2,150 sqft SBA unit is roughly 1,330–1,500 sqft of actual carpet area.** For two people that remains comfortable, but it is worth walking a sample flat rather than trusting the brochure number — the gap between 2,150 and ~1,400 surprises most buyers.

### 9.4 Tax benefit is fully available

With no existing self-occupied property carrying a loan, the §24(b) aggregation trap in §8.7 does not apply. Year-one interest on ₹1.3 Cr at 8% is ~₹10.3 L, so the **₹2 L cap is fully consumed from day one**, worth **~₹62,400/year at the 30% slab** — and interest stays above ₹2 L until roughly year 17 of a 20-year term, so this is a durable benefit of roughly **₹11 L nominal** over the loan life. Section 80C on principal (₹1.5 L) is also available, subject to your other 80C usage.

This materially improves the case for the **20-year tenure** over 15: the longer term keeps interest above the ₹2 L threshold for more years, partly offsetting its higher total interest cost.

### 9.5 Candidates that actually fit

From the seeded shortlist, filtered against the corrected budget and the target size band:

| Project | Locality | Units | Size range | Senior score | Fit |
|---|---|---|---|---|---|
| **EIPL Skyila** | Puppalaguda / Manikonda | 180 | 1,320–2,190 sqft | 72 | ✅ Top units reach 2,190 sqft; ready since 2018 with an active resale market |
| **My Home Avatar** | Puppalaguda | 2,800 | 1,180–2,100 sqft | 80 | ✅ Tops out at 2,100 sqft; fully occupied, mature community |
| **Lansum Etania** | Nanakramguda | 372 | 1,890–4,085 sqft | **85** | ⚠️ **Stretch candidate** — see below |

**Practical target size is 2,000–2,190 sqft**, not 2,000–2,300 — nothing in the viable submarket goes higher.

**Lansum Etania deserves a hard look despite being marginal.** It has the best senior-fit score of anything researched (85), and Yashoda Hospital's registered address is literally "Behind Lansum Etania Apartments Complex" — under 500 m, walkable. That single fact neutralises the Kokapet corridor's worst weakness and delivers most of what made Banjara Hills Rd 12 attractive, at a fraction of the price. Its entry unit is 1,890 sqft, just below your band, and Nanakramguda pricing is higher than Puppalaguda — so it will be tight. **Get a quote on the 1,890 sqft units specifically before dismissing it on size.**

### 9.6 Revised recommendation

1. **Drop Banjara Hills Road No. 12** unless the budget rises to ~₹3.6 Cr all-in.
2. **Concentrate the search on Puppalaguda / Manikonda**, targeting 2,000–2,190 sqft.
3. **Price Lansum Etania's 1,890 sqft units as a serious exception** — trading ~150 sqft for a walkable tertiary hospital is a good trade for a 75-year-old.
4. **Borrow solo, 20-year tenure**, then gift-deed a share post-closure (§3).
5. Budget **₹2.2 L/year** carrying cost and **₹5–15 L** of one-time extras beyond the sale price.

## Sources

- [Kokapet ready-to-move projects — SquareYards](https://www.squareyards.com/ready-to-move-projects-in-kokapet-hyderabad)
- [Kokapet locality guide 2026 — ASBL](https://asbl.in/blog/kokapet-locality-guide-2026-luxury-apartments-master-plan-property-outlook/)
- [Neopolis Kokapet price trends 2026](https://bigproperty.in/blog/neopolis-kokapet-real-estate-price-trends-2026/)
- [Rajapushpa Properties](https://rajapushpa.in/)
- [Banjara Hills property rates](https://aurorealty.com/blog/banjara-hills-property-rates/)
- [The Valencia, Road No. 12 — Honeyy Group](https://www.honeyygroup.com/property-details/flats-and-plots-in-hyderabad/the-valencia-project-in-banjara-hills/236)
- [Banjara Hills property rates — 99acres](https://www.99acres.com/property-rates-and-price-trends-in-banjara-hills-hyderabad-prffid)
- [Virinchi Hospitals, Road No. 12](https://www.credihealth.com/hospital/virinchi-hospital-banjara-hills)
- [Continental Hospitals](https://continentalhospitals.com/)
- [AIG Hospitals](https://www.aighospitals.com/)
- [SBI home loan rates Aug 2026 — UrbanMoney](https://www.urbanmoney.com/home-loan/state-bank-of-india/interest-rate)
- [Lowest home loan rates 2026 — ClearTax](https://cleartax.in/s/lowest-home-loan-interest-rate)
- [Home loans for senior citizens — MyMoneyMantra](https://www.mymoneymantra.com/blog/home-loans-for-senior-citizens-eligibility-interest-rate-and-emi)
- [Hyderabad maintenance charges — NoBrokerHood](https://www.nobrokerhood.com/blog/apartment-maintenance-charges-in-hyderabad/)
- [Real cost of buying in Hyderabad 2026 — ASBL](https://asbl.in/blog/what-is-the-real-cost-of-buying-an-apartment-in-hyderabad-in-2026/)
- [Hyderabad Metro Phase 2 — HMRL](https://hmrl.co.in/hyderabad-metro-phase-2-gains-momentum/)
