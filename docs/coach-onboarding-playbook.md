# BodyMorph Business Office — Coach Onboarding Playbook

**Purpose:** the exact process for bringing a new coach onto BodyMorph. Run it the same way every time, whether it's Neal or a team member. A coach is "onboarded" when all four exit criteria at the bottom are true — not before.

**Time budget:** ~45 minutes live with the coach + ~10 minutes of prep.

---

## PHASE 0 — Before the setup session (prep, ~10 min)

The sale is closed ($497 setup + $29/client/mo agreed). Before you get on the call:

**0.1 — Collect from the coach (text or email):**
- Full name, email, mobile number
- Business name (exactly as they want clients to see it)
- Logo file if they bought branding (PNG with transparent background preferred)
- Their consulting fee (what they charge clients per month)
- Their in-person session rate
- Their monthly income goal (ask: "What do you want this business doing per month in 90 days?")

**0.2 — Collect the $497 setup fee.** (Manual for now — invoice/Zelle/etc. Stripe flow comes with the billing build.) Do not run the setup session before it's paid.

**0.3 — Mint their access code.** Supabase → SQL Editor, run (replace both values):

```sql
insert into coach_access_codes (code, email)
values ('LASTNAME-497', 'coach@email.com');
```

- Code convention: `LASTNAME-497` (memorable, single-use by default).
- Binding the email is optional but do it — the code then only works for them.
- To revoke a code that leaked: `update coach_access_codes set disabled = true where code = 'LASTNAME-497';`

**0.4 — Book the setup session:** 45 minutes, video call with screen share (or in person). Tell them: *"Have your phone with you and one real client in mind — we're going to onboard them together before we hang up."*

---

## PHASE 1 — The setup session (live, ~45 min)

Share your screen for steps they watch; have THEM share/drive for steps they do. They should leave having clicked everything once.

### Step 1 — Account (5 min, coach drives)
1. Coach goes to **bodymorph.info**, creates an account (email + password), verifies their phone number.
2. On the first questionnaire screen they tap **"I'm a coach — enter access code"** and enter their code.
3. They land on the coach dashboard. That moment matters — say: *"This is your business command center. Everything we do from here is about the number in the middle of that ring."*

### Step 2 — Money settings (10 min, coach drives, you guide)
Dashboard → **Settings**:
1. **Personal information** — name and phone (this is what clients see).
2. **Consulting fee** and **in-person session rate** (Financials section → rates). Use the numbers from Phase 0 — if they hesitate, coach them up, not down.
3. **Monthly financial goal** — enter the 90-day number from Phase 0. Show them the Overview ring tracking toward it. This is the hook that brings them back to the dashboard daily.

### Step 3 — Branding, if purchased (5 min, coach drives)
Settings → **"Your brand on the app"**: business name, upload the logo, pick the accent color, check the live preview, Save. Say: *"Every client you sign opens the app to YOUR brand from day one."*

### Step 4 — Their own training profile (5 min, coach drives)
Settings → **My Training App** → run the questionnaire for themselves.
- Why it's mandatory: a coach who uses the app sells the app. They must feel the voice coach, the logging, and the meal plan before they can demo them.
- Tell them to do one voice-coach workout before their first client demo.

### Step 5 — Onboard their first client, together (10 min, coach drives)
This is the most important step. Clients tab → **Invite Client** → **Guided intake**.
- If they brought a real client's info: run it for real and text the invite.
- If not: run it as a rehearsal with a made-up client, then delete/ignore the invite.
- Point out the yellow COACH tips on each step — *"the intake teaches you as you go; the training video covers the same thing."*
- Send them the coach training video link afterward.

### Step 6 — The weekly rhythm (5 min, you drive)
Show — don't configure — the four habits that make the money:
1. **Weekly Report** (open any client → Generate): *"read this before every check-in; it tells you what to say."*
2. **Follow-ups** queue: *"the app watches your roster and tells you who needs a text today."*
3. **At-risk clients** on Overview: *"nobody ghosts without you knowing in week one."*
4. **Log in-person sessions** (Financials): *"every session you log counts toward your monthly ring."*

### Step 7 — Marketing offer (3 min)
If they're a fit, present the marketing add-on: *"$100 flat per month — we run your Facebook, Google, and TikTok ads and the leads land in your dashboard."* Yes → note it for GHL sub-account setup (separate process). No → move on, revisit at day 30.

### Step 8 — Close (2 min)
- Confirm they know their one job this week: **invite their first three clients using guided intake.**
- Tell them exactly how to reach support (current channel: text Neal).
- Book the **day-7 check-in call** before hanging up.

---

## PHASE 2 — After the session (follow-through)

- **Same day:** log the coach in the tracking sheet (name, date onboarded, code used, fees, goal, branding Y/N, marketing Y/N, day-7 date).
- **Day 7 check-in (booked in Step 8):** Have they invited 3 clients? Used guided intake? Generated a Weekly Report? Unblock whatever stopped them.
- **Day 30 review:** income vs. the goal they set. Upsell branding and/or marketing if they passed earlier. Ask for a referral: *"who's one coach you know who should be on this?"*

---

## EXIT CRITERIA — the coach is onboarded when ALL four are true

1. ✅ Dashboard live: account created, code redeemed, fees + monthly goal set.
2. ✅ Their own training profile exists (they ARE a user).
3. ✅ At least one client invited via guided intake (real or rehearsed live).
4. ✅ Day-7 check-in on the calendar.

If any box is unchecked, the onboarding isn't done — finish it before moving to the next coach.

---

### Notes for the team
- Never send an access code before the $497 clears.
- One code = one coach. Never reuse codes; mint a fresh one per coach.
- The setup session script above doubles as the outline for a future "coach setup" training video — same treatment as the client onboarding video.
