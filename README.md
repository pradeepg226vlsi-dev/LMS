# Antigravity LMS - Assignment Tracking System

An enterprise-grade, responsive, and visual Assignment Tracking Portal designed to support up to 60 students and a mentor. 

The architecture links a custom modern frontend dashboard directly to **Google Sheets** (acting as the relational database) and **Google Drive** (for storing assignment documents) using a serverless **Google Apps Script Web App API**.

---

## Technical Stack & Architecture

```text
               +----------------------------------------+
               |        Custom Web Frontend             |
               | (Sleek Dark UI: index.html / app.js)   |
               +-------------------+--------------------+
                                   |
                                   | HTTP POST / GET (JSON)
                                   v
               +-------------------+--------------------+
               |     Google Apps Script API Engine     |
               |      (google-apps-script.gs Web App)   |
               +---------+--------------------+---------+
                         |                    |
                         | Apps Script API    | Drive API
                         v                    v
               +---------+--------+  +--------+---------+
               |  Google Sheets   |  |  Google Drive    |
               | (Tab Database)   |  | (Document Store) |
               +------------------+  +------------------+
```

---

## ⚡ Quick Start (Instant Local Evaluation)

To view the UI and test the full student-mentor workflow immediately without any cloud configurations:
1. Double-click the [index.html](file:///c:/Users/knani/Downloads/LMS/index.html) file to open the dashboard in your web browser (or serve it with a local server).
2. The platform boots in **Mock Mode** by default, loading a pre-populated, data-rich student/assignment database from your browser's local storage.
3. Use the **Active Session** dropdown in the bottom-left of the sidebar to swap roles:
   * **Mentor View**: Create new assignments, attach instruction files, view all submissions, and grade commits.
   * **Student View**: Swap profiles (e.g. Alex Mercer, Bruce Wayne) to see assignments, download resource files, and submit GitHub repository commits.

---

## ☁️ Production Cloud Setup (Google Integration)

### Step 1: Create Your Google Spreadsheet
1. Open [Google Sheets](https://sheets.google.com) and create a **blank spreadsheet**.
2. Give the spreadsheet a name (e.g. `AG LMS Database`).
3. You do **not** need to create the tabs manually. The Apps Script backend will automatically initialize the required Sheets (`Students`, `Assignments`, `Submissions`, `Reviews`, and `Logs`) with correct columns and styling on its first boot!

### Step 2: Deploy Google Apps Script API
1. In your new spreadsheet, click **Extensions** > **Apps Script** from the top menu.
2. In the Apps Script Editor, delete any placeholder code.
3. Open the [google-apps-script.gs](file:///c:/Users/knani/Downloads/LMS/google-apps-script.gs) file from this workspace, copy the entire content, and paste it into the Apps Script editor.
4. Click the **Save** icon (floppy disk).

### Step 3: Publish the Web App
1. Click the **Deploy** button in the top-right corner and select **New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Configure the fields exactly as follows:
   * **Description**: `LMS Backend API v1`
   * **Execute as**: `Me (your-google-email@gmail.com)` (This grants the script permission to write to your Sheet and save files to your Google Drive).
   * **Who has access**: `Anyone` (This allows your web frontend to query the API. *Note: Apps Script secure tokens are managed automatically*).
4. Click **Deploy**.
5. Grant authorization permissions (click "Advanced" and "Go to LMS Script (unsafe)" if prompted by Google's standard security screen).
6. Copy the **Web App URL** generated in the confirmation window.

### Step 4: Link Frontend Dashboard to Google API
1. Open your local [index.html](file:///c:/Users/knani/Downloads/LMS/index.html) dashboard in your browser.
2. Click the **API Settings** button in the top-right of the header.
3. Change the **Database Source Mode** to `Live Google Workspace API`.
4. Paste the copied **Web App URL** into the input field.
5. Click **Save Configurations**.
6. The status badge in the header will light up green: **Live API Mode**. The app is now reading and writing directly to your Google Spreadsheet in real-time!

---

## 👥 Roster Management (Supporting 60 Students)

1. The first time the Apps Script backend connects, it seeds 4 placeholder students in the `Students` sheet.
2. To scale this to your group of 60 students:
   * Open your Google Sheet and navigate to the **Students** tab.
   * Add rows with columns: `student_id` (e.g., `S1001` to `S1060`), `name`, `email`, and `github_username`.
   * Save the Sheet.
3. The frontend sidebar's student profile selector will automatically pull all student names directly from your Spreadsheet on the next load, making it simple to manage roles.
