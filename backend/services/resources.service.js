const mongoose = require('mongoose');
const Resource = require('../models/resource.model');

// Realistic starter documents so a fresh deploy doesn't show an empty library.
// Idempotent — only inserts when the collection is empty, so it never runs
// again once management has uploaded (or deleted down to zero) real documents.
const EXAMPLES = [
  {
    title: 'House Rules & By-Laws (2026 Edition)',
    category: 'By-Laws',
    file_name: 'the-lumina-house-rules-2026.txt',
    content: `THE LUMINA — HOUSE RULES & BY-LAWS
2026 Edition — effective 1 January 2026

1. GENERAL CONDUCT
Residents and their guests must not act in a way that interferes with other
residents' quiet enjoyment of their units or the common property. Management
may issue a written notice for any breach of these by-laws; repeated breaches
may be referred to the Management Corporation for further action.

2. NOISE & NUISANCE
Quiet hours are 10:00pm–8:00am daily. Renovation and other works that
generate noise are only permitted 9:00am–5:00pm, Monday to Saturday, excluding
public holidays. Musical instruments, amplified sound, and floor work
(hacking, drilling) are not permitted during quiet hours under any
circumstance.

3. RENOVATIONS & ALTERATIONS
Any renovation affecting shared walls, plumbing stacks, or the building
facade requires written approval from Management before work begins. A
refundable renovation deposit is required; the amount is confirmed at the
time of application. Contractors must register with the guardhouse and are
only permitted building access during approved working hours.

4. PETS
One dog or cat per unit is permitted, subject to registration with
Management. Pets must be leashed at all times in common areas and are not
permitted in the pool, gym, or function rooms. Owners are responsible for
immediate clean-up in common areas.

5. PARKING
Each unit is allocated parking per its title deed. Visitor parking is
limited to 4 hours and subject to guardhouse logging. Double-parking,
parking in fire lanes, and parking in another resident's allocated lot are
enforceable breaches.

6. COMMON PROPERTY & FACILITIES
Facility bookings (function room, BBQ pits, tennis court) are made through
the resident portal and are subject to the posted booking policy. Residents
are liable for any damage caused by themselves or their guests to shared
facilities during a booking.

7. ENFORCEMENT
Management may issue a written warning, and where necessary refer matters to
the Management Corporation Strata Title (MCST) council for a formal by-law
enforcement process, including any applicable fines permitted under the
Building Maintenance and Strata Management Act.

— Building Management, The Lumina`,
  },
  {
    title: 'Fire Safety & Emergency Evacuation Guide',
    category: 'Fire Safety',
    file_name: 'the-lumina-fire-safety-guide.txt',
    content: `THE LUMINA — FIRE SAFETY & EMERGENCY EVACUATION GUIDE
Reviewed Q1 2026 by Building Management, in accordance with SCDF requirements.

ASSEMBLY POINTS
On hearing the fire alarm or an instruction to evacuate, proceed calmly via
the nearest fire escape stairwell (do not use lifts) to the designated
assembly point at the open car park forecourt, Level 1. Wait for a headcount
and further instructions from the Fire Safety Manager or emergency services.

FIRE EXTINGUISHER & HOSE REEL LOCATIONS
Fire extinguishers and hose reels are located at every lift lobby on every
floor, and at both ends of each basement car park level. Extinguishers are
inspected and tagged monthly; report a missing or discharged unit to
Management immediately.

EVACUATION ROUTES
Each floor has two fire escape stairwells, clearly signed with illuminated
"EXIT" markers. Evacuation route diagrams are posted at every lift lobby.
Residents should familiarise themselves with both routes from their unit, as
one may be inaccessible depending on the fire's location.

FIRE DRILLS
A building-wide fire drill is conducted twice a year, typically in April and
October. Residents are notified at least one week in advance via the
Announcements tab. Participation is strongly encouraged — this is the best
way to know your evacuation route before a real emergency.

IN YOUR UNIT
- Do not store items in corridors or stairwells; they are fire escape routes
  and obstruction is both a safety hazard and a by-law breach.
- Test your unit's smoke detector monthly; report a faulty unit to
  Management for replacement.
- Know the location of your unit's isolation valve (gas) and the nearest
  hose reel before you need them.

EMERGENCY CONTACTS
Singapore Civil Defence Force (fire/ambulance): 995
Guardhouse (24 hours): available via the intercom at every lobby
Building Management (office hours): available via the Messages tab

— Building Management, The Lumina`,
  },
  {
    title: 'Annual General Meeting — Minutes',
    category: 'Meeting Minutes',
    file_name: 'the-lumina-agm-minutes-2026-03-15.txt',
    content: `THE LUMINA — MANAGEMENT CORPORATION STRATA TITLE (MCST)
MINUTES OF THE ANNUAL GENERAL MEETING
Held Sunday, 15 March 2026, 10:00am, Function Room, Level 2

ATTENDANCE
Council members present: Chairperson, Secretary, Treasurer, and 2 council
members. 38 unit owners attended in person or by proxy, constituting a valid
quorum under the MCST by-laws.

1. ADOPTION OF PREVIOUS MINUTES
Minutes of the AGM held 12 March 2025 were adopted without amendment.

2. TREASURER'S REPORT
The Treasurer presented the audited financial statements for FY2025. The
sinking fund balance stood at a healthy reserve, sufficient to cover the
scheduled facade repainting in FY2027. Maintenance fees remain unchanged for
FY2026.

3. FACILITY UPGRADES
Council proposed replacing the Level 1 gymnasium equipment, budgeted from the
sinking fund. Motion proposed by Unit #12-04, seconded by Unit #08-11.
Resolution passed 34 votes for, 2 against, 2 abstentions.

4. PEST CONTROL CONTRACT RENEWAL
The existing pest control vendor's contract was renewed for a further 2
years at the same rate. Resolution passed unanimously.

5. CAR PARK SEASON PARKING REVIEW
Council noted rising demand for season parking lots and will review the
allocation policy over the next quarter, with findings to be shared via the
Announcements tab before any change takes effect.

6. ELECTION OF COUNCIL MEMBERS
The existing council was re-elected unopposed for a further one-year term.

7. ANY OTHER BUSINESS
A resident raised concerns about visitor parking congestion on weekends;
Council will review guardhouse logging data and report back at the next
council meeting.

NEXT AGM
The next Annual General Meeting is scheduled for March 2027; exact date to
be announced via the Announcements tab.

Meeting closed at 11:42am.

— Secretary, MCST Council, The Lumina`,
  },
  {
    title: 'Strata Title Plan — Lot Particulars & Common Property',
    category: 'Strata Title Plan',
    file_name: 'the-lumina-strata-title-summary.txt',
    content: `THE LUMINA — STRATA TITLE PLAN SUMMARY
Common Property & Lot Particulars Extract

DEVELOPMENT
Strata development comprising 2 residential towers over a shared podium,
with basement car parking and Level 1–2 shared facilities.

LOT PARTICULARS
Individual unit share values, floor areas, and lot boundaries are set out in
the full Strata Title Plan lodged with the Singapore Land Authority (SLA)
under the relevant Strata Titles Board plan reference. Unit owners may
request a certified copy of their individual lot's title plan from
Management for conveyancing, renovation, or insurance purposes.

COMMON PROPERTY
Common property includes all shared corridors, lift lobbies, stairwells,
the podium function room, gymnasium, swimming pool, BBQ pits, tennis court,
landscaped gardens, and basement car park drive aisles. Maintenance of
common property is funded through monthly maintenance fees and the sinking
fund, as approved at each Annual General Meeting.

SHARE VALUES
Each unit's share value (used to apportion maintenance fees and voting
rights at general meetings) is fixed at the time of the strata subdivision
and recorded against the unit's title. Share values are not affected by
subsequent renovations to an individual unit.

AMENDMENTS
Any amendment to the strata title plan (e.g. sub-division, boundary changes)
requires approval from the Management Corporation at a general meeting and
lodgement with the SLA. Management holds the master copy of the registered
plan on file for reference.

— Building Management, The Lumina`,
  },
];

async function seedExamples() {
  if (mongoose.connection.readyState !== 1) return;
  const count = await Resource.countDocuments().catch(() => -1);
  if (count !== 0) return; // already has documents (real or previously seeded) — never overwrite
  const docs = EXAMPLES.map(e => {
    const buf = Buffer.from(e.content, 'utf8');
    return {
      title: e.title,
      category: e.category,
      visibility: 'residents',
      file_data: `data:text/plain;base64,${buf.toString('base64')}`,
      file_name: e.file_name,
      file_type: 'text/plain',
      file_size: buf.length,
      uploaded_by: 'management',
    };
  });
  await Resource.insertMany(docs);
  console.log(`[resources] seeded ${docs.length} example document(s)`);
}

module.exports = { seedExamples };
