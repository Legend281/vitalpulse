I need you to build donor KYC review (national ID + selfie photos) 
using ONLY Firestore — no Firebase Storage, no Cloud Functions. This 
must stay entirely within Firebase's free Spark plan.

Read this ENTIRE prompt before writing any code. Build it in the 
exact order below — Step 1, then Step 2, then Step 3, then Step 4 — 
and do not skip ahead. Each step depends on the one before it working 
correctly.

============================================================
STEP 1: DATA MODEL (build this first, nothing else yet)
============================================================

Add these fields to each donor's document at donors/{uid}:

  kycStatus          — text, one of: "not_submitted", "pending", 
                        "verified", "rejected"
  kycIdImageBase64    — text, the ID photo converted to a long text 
                        string (explained in Step 2)
  kycSelfieImageBase64 — text, same idea, for the selfie photo
  kycSubmittedAt      — timestamp, when the donor submitted
  kycRejectionReason  — text or empty, only ever set by an admin
  kycReviewedBy       — text or empty, the admin's user ID, only 
                        ever set by an admin
  kycReviewedAt       — timestamp or empty, only ever set by an admin

Add ONE field to each admin's document at users/{uid}:

  isAdmin — true or false. Defaults to false/absent for every normal 
            account. This field will NEVER be set by any code in the 
            app — only I will set it manually, by hand, inside the 
            Firebase Console, for the specific people who should be 
            admins. Do not write any button, form, or function 
            anywhere in the app that sets this field. If you think 
            you need one, stop and ask me first.

Confirm this step by showing me the exact new fields added to both 
collections before moving to Step 2.

============================================================
STEP 2: IMAGE COMPRESSION (build and test before Step 3)
============================================================

WHY THIS STEP EXISTS: Firestore documents have a hard limit of 1MB 
each. A normal phone photo can easily be 3-5MB. If we don't shrink 
the photo first, the donor's KYC submission will fail to save, or 
will silently corrupt other data in the same document. This step 
must work correctly before anything else can work.

Before converting either photo (ID or selfie) to text for storage:
1. Draw the image onto an HTML canvas element.
2. Resize it so neither width nor height exceeds 800 pixels 
   (maintain the original aspect ratio — don't stretch it).
3. Export the canvas as a JPEG at roughly 60-70% quality.
4. Convert THAT compressed result to the base64 text string — not 
   the original full-size photo.

TEST THIS STEP BY ITSELF, before continuing:
- Take a real photo from a real phone (ask me for a test photo if 
  you need one, or use any photo you have access to).
- Run it through this compression process.
- Tell me the resulting file size in KB.
- If either the ID photo or the selfie, when combined together in 
  one document, would push the total document size close to or over 
  1MB, reduce the dimensions or quality further and test again.
- Do not proceed to Step 3 until you've shown me an actual measured 
  file size that fits safely under the limit with room to spare.

============================================================
STEP 3: FIRESTORE SECURITY RULES (the most important step — 
read this section twice)
============================================================

WHY THIS STEP MATTERS MOST: Because we have no Cloud Function 
checking things on the server, these security rules ARE the entire 
security system for this feature. If these rules have a mistake, 
there is nothing else backing them up. A donor could otherwise open 
their browser's developer tools and try to directly write 
"kycStatus: verified" to their own document — these rules are what 
stops that from working.

Add these exact rules (I'll explain what each part does so you 
understand why it's written this way, not just copy it blindly):

  function isAdmin() {
    return request.auth != null &&
      get(/databases/$(database)/documents/users/$(request.auth.uid)).data.isAdmin == true;
  }

  // ↑ This function checks: is the person making this request 
  // logged in AND does their own user record have isAdmin set to 
  // true? If either is false, this returns false.

  match /donors/{donorId} {
    allow read: if request.auth.uid == donorId || isAdmin();
    // ↑ A donor can read their own record. An admin can read anyone's.
    // Nobody else can read donor records at all.

    allow create: if request.auth.uid == donorId;
    // ↑ A donor can create their own record (this happens once, 
    // when they first sign up).

    allow update: if isAdmin() || (
      request.auth.uid == donorId &&
      resource.data.kycStatus in ['not_submitted', 'rejected'] &&
      request.resource.data.kycStatus == 'pending' &&
      request.resource.data.kycReviewedBy == resource.data.kycReviewedBy &&
      request.resource.data.kycReviewedAt == resource.data.kycReviewedAt
    );
    // ↑ Read this carefully — this is the line that actually 
    // protects everything:
    // - An admin (isAdmin() == true) can update anything on this 
    //   document, no restrictions.
    // - A donor updating their OWN document can ONLY do so if:
    //   (a) their CURRENT status is "not_submitted" or "rejected" 
    //       — meaning they haven't already submitted, or their last 
    //       submission was rejected and they're trying again
    //   (b) the NEW status they're trying to set is EXACTLY "pending" 
    //       — never "verified", never anything else
    //   (c) they are NOT changing kycReviewedBy or kycReviewedAt at 
    //       all — those fields must stay exactly as they already were
    // - If a donor tries anything outside these exact conditions — 
    //   including trying to set their own status to "verified" — 
    //   this rule returns false and Firestore REJECTS the write.
  }

  match /users/{userId} {
    allow read: if request.auth != null;
    allow update: if request.auth.uid == userId &&
      request.resource.data.isAdmin == resource.data.isAdmin;
    // ↑ A user can update their own profile (name, etc.), but this 
    // rule specifically requires that whatever isAdmin value they 
    // ALREADY had stays exactly the same after their update. If 
    // someone tries to sneak "isAdmin: true" into an update that's 
    // otherwise just changing their name, this rule catches that 
    // one field not matching and rejects the entire write.
  }

Do not modify, simplify, or "clean up" the update rule for /donors/ 
— every single condition in it is there on purpose and removing any 
one of them reopens the security hole.

============================================================
STEP 4: ADMIN REVIEW SCREEN (build this last)
============================================================

Add a new view inside admin.html where an admin can review pending 
KYC submissions:

1. Query all donors where kycStatus equals "pending", sorted by 
   kycSubmittedAt (oldest first, so nobody waits longer than 
   necessary).
2. For each one, display both photos directly using the base64 text 
   — an <img> tag can display a base64 string directly by setting its 
   src to "data:image/jpeg;base64," followed by the stored text.
3. An "Approve" button that updates the document: sets kycStatus to 
   "verified", kycReviewedBy to the admin's own user ID, and 
   kycReviewedAt to the current time.
4. A "Reject" button that first shows the admin a list of reasons to 
   choose from:
     - Image unreadable
     - Name mismatch
     - Expired ID
     - Wrong document type
     - Selfie does not match ID
     - Suspected duplicate account
     - Signs of tampering
     - Incomplete submission
   Then updates the document: sets kycStatus to "rejected", 
   kycRejectionReason to whichever reason was picked, plus 
   kycReviewedBy and kycReviewedAt same as above.
5. AFTER either Approve or Reject happens successfully, immediately 
   clear both kycIdImageBase64 and kycSelfieImageBase64 back to 
   empty/null on that same document. We do this so we're not keeping 
   people's ID photos sitting in the database forever once they've 
   already been reviewed — only keep them while a review is actually 
   pending.

============================================================
STEP 5: TESTING — DO NOT SKIP OR SHORTEN THIS
============================================================

I will not consider this feature complete until you have actually 
performed EVERY test below and shown me the real result of each one 
— not described what should theoretically happen, actually done it 
and shown me what happened.

TEST 1 — Confirm a donor cannot self-approve:
  Log in as a normal donor test account. Attempt to directly write 
  kycStatus: "verified" to your own donor document (you can do this 
  through the browser console using the Firestore SDK, simulating 
  what someone tech-savvy might try). 
  EXPECTED RESULT: this write is rejected with a permissions error.
  Show me the actual error message you get.

TEST 2 — Confirm a donor cannot approve someone else:
  As the same donor test account, attempt to write to a DIFFERENT 
  donor's document.
  EXPECTED RESULT: rejected.

TEST 3 — Confirm nobody can grant themselves admin:
  As any non-admin logged-in account, attempt to write isAdmin: true 
  to your own users/{uid} document.
  EXPECTED RESULT: rejected.

TEST 4 — Confirm a real admin CAN approve/reject:
  In the Firebase Console, manually set isAdmin: true on one test 
  account. Log in as that account. Confirm you CAN successfully 
  approve a pending submission, and separately, CAN successfully 
  reject one with a reason.
  EXPECTED RESULT: both succeed.

TEST 5 — Confirm submission/resubmission rules:
  As a donor whose status is "not_submitted", confirm you CAN submit 
  KYC (status becomes "pending"). 
  As a donor whose status is "pending" (already submitted, awaiting 
  review), confirm you CANNOT submit again.
  As a donor whose status is "rejected", confirm you CAN resubmit.
  As a donor whose status is "verified", confirm you CANNOT submit 
  again.

TEST 6 — Confirm real-world file size:
  Using an actual photo (not a tiny test image), go through the full 
  submission flow and report the final size of the donor's document 
  in Firestore after both images are compressed and stored. Confirm 
  it is comfortably under 1MB — tell me the actual number, not just 
  "it fits."

Show me the results of all 6 tests, in order, before telling me this 
is done. If any test fails, fix it and re-run ALL 6 tests again from 
the start — don't just re-run the one that failed, since a fix to one 
rule can sometimes accidentally break another.