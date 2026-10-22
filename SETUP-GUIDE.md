# Student Assessment Portal — Secure Setup Guide

This version has a **real server behind it**. Passwords are checked on the server, every save is checked on
the server, and each person only ever receives the data they are allowed to see. The web page itself contains
no student data and no passwords.

## What is in this folder

| Path | What it is |
|---|---|
| `public/index.html` | The portal page (what users see) |
| `netlify/functions/api.mjs` | The server entry point (Netlify Function) |
| `netlify/functions/lib/core.mjs` | All security rules: sign-in, lockout, permissions, saving, SMS |
| `netlify.toml` | Netlify settings and security headers |
| `dev-server.mjs` | Run the whole portal on your own computer for testing |
| `test/` | Automated tests for the server |

## Deploy on Netlify (about 15 minutes)

Use a **new Netlify site** for the portal (keep your public school website, `asuomshs.netlify.app`, separate).

1. Put this folder in a GitHub repository (GitHub Desktop or "Upload files" on github.com works).
2. In Netlify: **Add new site → Import an existing project → GitHub →** choose the repository.
3. Build settings: leave the build command empty. Netlify reads `netlify.toml` automatically
   (publish folder `public`, functions in `netlify/functions`).
4. Before the first deploy finishes, open **Site configuration → Environment variables** and add:

| Variable | Value | Required |
|---|---|---|
| `SESSION_SECRET` | A long random text, 48+ characters (see below) | **Yes** |
| `ADMIN_PASSWORD` | A **starting** password for the administrator (8+ characters, letters and numbers). The administrator replaces it at the first sign-in | **Yes** |
| `ADMIN_USERNAME` | Administrator's sign-in ID. Default: `0051606` | No |
| `ADMIN_NAME` | Name shown for the administrator. Default: `School Administrator` | No |
| `ARKESEL_API_KEY` | Your Arkesel API key (only for sending SMS) | For SMS |
| `ARKESEL_SENDER` | Your approved Arkesel sender name, up to 11 characters, e.g. `ASUOMSHS` | For SMS |

To make a `SESSION_SECRET`, run this on any computer with Node installed and paste the result:

    node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

5. **Deploy site.** Open the site address and sign in with the administrator ID (`0051606`) and the starting `ADMIN_PASSWORD`.
   **The portal then asks the administrator to choose their own password** (8+ characters with letters and numbers)
   before anything opens. After that, the starting password stops working and only the new one is used.
6. Add your own domain under **Domain management**. Netlify provides the HTTPS certificate for free.

## First steps after signing in

1. **Update School Info** — school name, region, district, logo, contacts.
2. **Add/Manage Classes** — create the classes and their subjects.
3. **Manage Users → Add User** — add each teacher with a **temporary password** (8+ characters, letters and numbers) and tell it to them.
   On their first sign-in each teacher is asked to choose their own password; the same happens whenever you reset their password with *Change Password*.
   Then use *Assign Privilege* and *Assign Subj/Class* so each teacher only sees their own classes.
4. **Register Student** (or bulk upload) → **Parent Portal Access** → switch on access for the students.
5. Parents sign in with the **student's Ass't Ref ID** and the **date of birth** (dd/mm/yyyy) as the password.

## Sending SMS to parents (optional)

1. Create an account at arkesel.com, buy SMS credit, and get your **API key** and an approved **Sender ID**.
2. Add `ARKESEL_API_KEY` and `ARKESEL_SENDER` as environment variables (table above), then redeploy.
3. In **Parent Portal Access**, use **Bulk Message → Send SMS now**.

If the keys are missing the button tells you so; the Excel / WhatsApp options keep working.

## What the server protects against

* **Passwords:** stored only as salted hashes (scrypt) on the server. Not in the page, not in any file you download.
* **Guessing:** 5 wrong attempts on a username locks it for 15 minutes; one network address is limited too.
  The lock lives on the server, so clearing the browser does not remove it. Error messages do not reveal whether a username exists.
* **Permissions:** the server decides, not the page.
  * Parents receive only their own child, view-only.
  * Teachers receive only their assigned classes and can change scores only for their assigned subject and class.
  * Only the administrator can change school settings, classes, users, passwords, and send SMS.
  * Editing the page with browser developer tools does not help: the server rejects the change and restores the true data.
* **Sessions:** a sign-in lasts 30 minutes from the last action (the page also signs out after 15 minutes idle).
  Resetting a password or deactivating a user ends their open sessions at once.
* **Stored text** has `<` and `>` removed and images are checked, to stop scripts being planted in names or photos.
* **Login Trace** records every sign-in, failure, lock and sign-out on the server.

## Recovering the administrator account

Change `ADMIN_PASSWORD` in Netlify's environment variables and redeploy. It becomes a new temporary password for the administrator, who is asked to choose their own again at the next sign-in. (Leaving the setting unchanged never overwrites the password the administrator chose.)

## Running it on your own computer (testing)

    npm install
    npm run dev                       # empty school, admin password "ChangeMe-Now-123"
    SEED_DEMO=true npm run dev        # with sample students (first run only)

Open http://localhost:8888. Local data is kept in the `.devdata` folder (delete it to start again).
Automated tests: `npm test`.

## Honest limits

* **Back-ups:** Netlify stores your data, but keep your own copies: use *Manage Students → Download Student Data* regularly.
* **Size:** designed and load-tested with 1,500 students (all replies far below Netlify's 6 MB limit).
  Photos and signatures are shrunk automatically when uploaded.
* **Passwords:** every staff member can change their own with the **Change password** button at the top. If someone forgets theirs, the administrator resets it with *Change Password* in Manage Users (there is no "forgot password" e-mail yet).
* **The sheet password** for score templates (shown to the administrator only) protects the Excel file's sheet structure,
  not your data. It is not a security control.
* Netlify's free plan has monthly limits on function calls; a school of this size should fit, but check your plan.
* I could test everything except Netlify's live hosting and the live Arkesel service from here, so do a trial with a
  few test students and one test SMS to your own number before real use.

## End of year: graduating Form 3 (Year 3)
On **Progress All**, choosing a Year 3 class opens a "Graduate" window. Confirming it renames the class to e.g. `ARTS 1 (Class of 2026)`, marks the students Graduated, and removes the class from teachers' lists and from daily work. Nothing is deleted: find them in **Manage Students → Year → Graduated (Alumni)**, and print transcripts as usual. The old class name (ARTS 1) is then free for a new intake. **Undo graduation** is on Add/Manage Classes.
