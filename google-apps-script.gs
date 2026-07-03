/**
 * LMS Assignment Tracking System - Apps Script Backend
 * 
 * Instructions:
 * 1. Open Google Sheets (create a new one or use an existing spreadsheet).
 * 2. Click Extensions > Apps Script.
 * 3. Delete any default code and paste this code.
 * 4. Save and click "Deploy" > "New deployment".
 * 5. Select "Web app" as the type.
 * 6. Set Description: "LMS Backend API v1"
 * 7. Set Execute as: "Me" (your email)
 * 8. Set Who has access: "Anyone" (essential for direct API requests from the dashboard web client)
 * 9. Click Deploy, authorize permissions, and copy the Web App URL!
 */

// Route GET requests
function doGet(e) {
  return handleRequest(e);
}

// Route POST requests
function doPost(e) {
  return handleRequest(e);
}

// Main Request Handler
function handleRequest(e) {
  // CORS Configuration
  var response;
  try {
    var params = {};
    
    // Parse GET parameters
    if (e.parameter) {
      for (var key in e.parameter) {
        params[key] = e.parameter[key];
      }
    }
    
    // Parse POST body parameters
    if (e.postData && e.postData.contents) {
      try {
        var postJson = JSON.parse(e.postData.contents);
        for (var k in postJson) {
          params[k] = postJson[k];
        }
      } catch (err) {
        // Fallback if data is url-encoded or raw text
        params.postDataRaw = e.postData.contents;
      }
    }
    
    var action = params.action;
    if (!action) {
      throw new Error("No action specified in the request parameters.");
    }
    
    // Get active Google Spreadsheet
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var result;
    
    // API Router
    switch (action) {
      case "getInitialData":
        result = getInitialData(ss);
        break;
      case "getAssignments":
        result = getAssignments(ss);
        break;
      case "getSubmissions":
        result = getSubmissions(ss);
        break;
      case "getStudents":
        result = getStudents(ss);
        break;
      case "createAssignment":
        result = createAssignment(ss, params);
        break;
      case "submitAssignment":
        result = submitAssignment(ss, params);
        break;
      case "autogradingCallback":
        result = autogradingCallback(ss, params);
        break;
      case "reviewSubmission":
        result = reviewSubmission(ss, params);
        break;
      case "registerStudent":
        result = registerStudent(ss, params);
        break;
      case "saveAttendance":
        result = saveAttendance(ss, params);
        break;
      case "editAssignment":
        result = editAssignment(ss, params);
        break;
      case "deleteAssignment":
        result = deleteAssignment(ss, params);
        break;
      case "shareResource":
        result = shareResource(ss, params);
        break;
      case "deleteResource":
        result = deleteResource(ss, params);
        break;
      case "toggleStudentStatus":
        result = toggleStudentStatus(ss, params);
        break;
      case "getLogs":
        result = getLogs(ss);
        break;
      default:
        throw new Error("Unknown action: '" + action + "'");
    }
    
    response = { success: true, data: result };
  } catch (error) {
    response = { success: false, error: error.toString() };
  }
  
  // Format output as JSON
  var jsonString = JSON.stringify(response);
  return ContentService.createTextOutput(jsonString)
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------
// DATABASE & HELPER UTILITIES
// ---------------------------------------------------------

/**
 * Gets a sheet by name. If it doesn't exist, it creates it with headers.
 * If it does exist, it validates that the column headers in row 1 are set up correctly.
 */
function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  
  if (lastRow === 0 || lastColumn === 0) {
    sheet.appendRow(headers);
    
    // Format Header Row
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#0F172A"); // Slate 900
    headerRange.setFontColor("#F8FAFC"); // Slate 50
    headerRange.setHorizontalAlignment("left");
    sheet.setFrozenRows(1);
    
    // Auto-fit columns
    for (var i = 1; i <= headers.length; i++) {
      sheet.autoResizeColumn(i);
    }
  } else {
    // If sheet exists and has content, make sure headers are set correctly in row 1
    var existingHeaders = sheet.getRange(1, 1, 1, Math.max(lastColumn, headers.length)).getValues()[0];
    var needsUpdate = false;
    for (var j = 0; j < headers.length; j++) {
      if (String(existingHeaders[j]).trim() !== headers[j]) {
        needsUpdate = true;
        break;
      }
    }
    if (needsUpdate) {
      // Overwrite first row headers to align with the required schema
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      var headerRange = sheet.getRange(1, 1, 1, headers.length);
      headerRange.setFontWeight("bold");
      headerRange.setBackground("#0F172A");
      headerRange.setFontColor("#F8FAFC");
      headerRange.setHorizontalAlignment("left");
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

/**
 * Returns sheet data as an array of JavaScript objects.
 */
function getSheetDataAsObjects(sheet) {
  var range = sheet.getDataRange();
  var values = range.getValues();
  if (values.length <= 1) return [];
  
  var headers = values[0];
  var data = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = row[j];
    }
    data.push(obj);
  }
  return data;
}

/**
 * Appends a JavaScript object as a row to a sheet based on ordered headers.
 */
function appendObjectToSheet(sheet, headers, obj) {
  var row = [];
  for (var i = 0; i < headers.length; i++) {
    var val = obj[headers[i]];
    row.push(val !== undefined ? val : "");
  }
  sheet.appendRow(row);
  
  // Format cells dynamically if needed (e.g. alignment)
  sheet.getRange(sheet.getLastRow(), 1, 1, headers.length).setHorizontalAlignment("left");
}

/**
 * Updates a row matching a key field with new field values.
 */
function updateRowInSheet(sheet, headers, matchColName, matchVal, updateObj) {
  var range = sheet.getDataRange();
  var values = range.getValues();
  if (values.length <= 1) return false;
  
  var headersRow = values[0];
  var matchColIdx = headersRow.indexOf(matchColName);
  if (matchColIdx === -1) return false;
  
  // Look for match
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][matchColIdx]) === String(matchVal)) {
      var rowNum = i + 1;
      for (var key in updateObj) {
        var colIdx = headersRow.indexOf(key);
        if (colIdx === -1) {
          // Schema Migration: append missing header column in row 1
          colIdx = headersRow.length;
          headersRow.push(key);
          var headerCell = sheet.getRange(1, colIdx + 1);
          headerCell.setValue(key);
          headerCell.setFontWeight("bold");
          headerCell.setBackground("#0F172A");
          headerCell.setFontColor("#F8FAFC");
        }
        sheet.getRange(rowNum, colIdx + 1).setValue(updateObj[key]);
      }
      return true;
    }
  }
  return false;
}

/**
 * Gets or creates a Google Drive folder for files.
 */
function getOrCreateFolder(folderName) {
  var folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(folderName);
}

/**
 * Decodes and uploads a base64 string to a Google Drive folder,
 * and sets permissions to "Anyone with the link can view".
 */
function saveFileToDrive(fileName, base64Data, folderName) {
  var folder = getOrCreateFolder(folderName);
  
  // Clean base64 prefix if present (e.g., data:application/pdf;base64,)
  var contentBase64 = base64Data;
  if (base64Data.indexOf(",") !== -1) {
    contentBase64 = base64Data.split(",")[1];
  }
  
  var decoded = Utilities.base64Decode(contentBase64);
  var blob = Utilities.newBlob(decoded);
  blob.setName(fileName);
  
  var file = folder.createFile(blob);
  
  // Set shareable link permissions
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  
  return {
    name: file.getName(),
    url: file.getUrl(),
    id: file.getId()
  };
}

/**
 * Logs dashboard and API actions.
 */
function logAction(ss, action, userId, details) {
  var logsSheet = getOrCreateSheet(ss, "Logs", ['log_id', 'timestamp', 'action', 'user_id', 'details']);
  var logs = getSheetDataAsObjects(logsSheet);
  var logId = "LOG" + (1000 + logs.length + 1);
  
  var newLog = {
    log_id: logId,
    timestamp: new Date().toISOString(),
    action: action,
    user_id: userId,
    details: details
  };
  
  appendObjectToSheet(logsSheet, ['log_id', 'timestamp', 'action', 'user_id', 'details'], newLog);
}

// ---------------------------------------------------------
// API HANDLERS
// ---------------------------------------------------------

/**
 * Fetches all base tables to initialize the frontend with a single request.
 */
function getInitialData(ss) {
  var studentsSheet    = getOrCreateSheet(ss, "Students",    ['student_id', 'name', 'email', 'github_username', 'status', 'username', 'password']);
  var mentorsSheet     = getOrCreateSheet(ss, "Mentors",     ['mentor_id', 'name', 'email', 'status', 'username', 'password']);
  var assignmentsSheet = getOrCreateSheet(ss, "Assignments", ['assignment_id', 'title', 'subject', 'description', 'instructions', 'deadline', 'drive_file_name', 'drive_file_url', 'created_date', 'status', 'allow_late_submissions']);
  var submissionsSheet = getOrCreateSheet(ss, "Submissions", ['submission_id', 'assignment_id', 'student_id', 'student_name', 'repo_link', 'commit_hash', 'commit_url', 'submitted_time', 'status', 'marks', 'feedback', 'student_comments']);
  var attendanceSheet  = getOrCreateSheet(ss, "Attendance",  ['student_id', 'date', 'status']);
  var resourcesSheet   = getOrCreateSheet(ss, "Resources",   ['resource_id', 'title', 'type', 'url', 'created_date', 'shared_by']);

  // Seed Mentors ONCE if empty
  var mentors = getSheetDataAsObjects(mentorsSheet);
  if (mentors.length === 0) {
    var seedMentors = [
      { mentor_id: "M1001", name: "Mentor Admin", email: "mentor@suretrust.org", status: "Active", username: "mentor", password: "mentor123" }
    ];
    for (var m = 0; m < seedMentors.length; m++) {
      appendObjectToSheet(mentorsSheet, ['mentor_id', 'name', 'email', 'status', 'username', 'password'], seedMentors[m]);
    }
    mentors = seedMentors;
  }

  // Seed the 50-student G2-26 VLSI roster ONCE (only if Students sheet is empty)
  var students = getSheetDataAsObjects(studentsSheet);
  if (students.length === 0) {
    var seedStudents = [
      { student_id: "S1001", name: "ADITHYA",               email: "adithya.vlsi@suretrust.org",        github_username: "adithya-vlsi",        username: "adithya.vlsi",       password: "student123" },
      { student_id: "S1002", name: "ADITHYAN MANI",          email: "adithyan.vlsi@suretrust.org",       github_username: "adithyan-vlsi",       username: "adithyan.vlsi",      password: "student123" },
      { student_id: "S1003", name: "ANJI BABU",              email: "anjibabu.vlsi@suretrust.org",       github_username: "anjibabu-vlsi",       username: "anjibabu.vlsi",      password: "student123" },
      { student_id: "S1004", name: "ANKITH",                 email: "ankith.vlsi@suretrust.org",         github_username: "ankith-vlsi",         username: "ankith.vlsi",        password: "student123" },
      { student_id: "S1005", name: "ANU REDDY",              email: "anureddy.vlsi@suretrust.org",       github_username: "anureddy-vlsi",       username: "anureddy.vlsi",      password: "student123" },
      { student_id: "S1006", name: "ANUSHA",                 email: "anusha.vlsi@suretrust.org",         github_username: "anusha-vlsi",         username: "anusha.vlsi",        password: "student123" },
      { student_id: "S1007", name: "ARAVAPALLI RAMYA",       email: "aramya.vlsi@suretrust.org",         github_username: "aramya-vlsi",         username: "aramya.vlsi",        password: "student123" },
      { student_id: "S1008", name: "ARYAN SONI",             email: "asoni.vlsi@suretrust.org",          github_username: "asoni-vlsi",          username: "asoni.vlsi",         password: "student123" },
      { student_id: "S1009", name: "B. CHANDRA PRASAD",      email: "bchandra.vlsi@suretrust.org",       github_username: "bchandra-vlsi",       username: "bchandra.vlsi",      password: "student123" },
      { student_id: "S1010", name: "B. DIVYA",               email: "bdivya.vlsi@suretrust.org",         github_username: "bdivya-vlsi",         username: "bdivya.vlsi",        password: "student123" },
      { student_id: "S1011", name: "D. SAI TEJA",            email: "dsaiteja.vlsi@suretrust.org",       github_username: "dsaiteja-vlsi",       username: "dsaiteja.vlsi",      password: "student123" },
      { student_id: "S1012", name: "DEDEEPYA NARAYANASETTY", email: "dedeepya.vlsi@suretrust.org",       github_username: "dedeepya-vlsi",       username: "dedeepya.vlsi",      password: "student123" },
      { student_id: "S1013", name: "G. SIDDARTHA",           email: "gsiddartha.vlsi@suretrust.org",     github_username: "gsiddartha-vlsi",     username: "gsiddartha.vlsi",    password: "student123" },
      { student_id: "S1014", name: "GB SAI CHARAN",          email: "gbsaicharan.vlsi@suretrust.org",    github_username: "gbsaicharan-vlsi",    username: "gbsaicharan.vlsi",   password: "student123" },
      { student_id: "S1015", name: "GOWTHAM",                email: "gowtham.vlsi@suretrust.org",        github_username: "gowtham-vlsi",        username: "gowtham.vlsi",       password: "student123" },
      { student_id: "S1016", name: "HABIMUNNISA SHAIK",      email: "habimunnisa.vlsi@suretrust.org",    github_username: "habimunnisa-vlsi",    username: "habimunnisa.vlsi",   password: "student123" },
      { student_id: "S1017", name: "HIMANSHU PAL",           email: "himanshupal.vlsi@suretrust.org",    github_username: "himanshupal-vlsi",    username: "himanshupal.vlsi",   password: "student123" },
      { student_id: "S1018", name: "JASMEEN KAUR",           email: "jasmeen.vlsi@suretrust.org",        github_username: "jasmeen-vlsi",        username: "jasmeen.vlsi",       password: "student123" },
      { student_id: "S1019", name: "K. LOHITHA",             email: "klohitha.vlsi@suretrust.org",       github_username: "klohitha-vlsi",       username: "klohitha.vlsi",      password: "student123" },
      { student_id: "S1020", name: "K. SHASHI KUMAR",        email: "kshashikumar.vlsi@suretrust.org",   github_username: "kshashikumar-vlsi",   username: "kshashikumar.vlsi",  password: "student123" },
      { student_id: "S1021", name: "KRUTHIK",                email: "kruthik.vlsi@suretrust.org",        github_username: "kruthik-vlsi",        username: "kruthik.vlsi",       password: "student123" },
      { student_id: "S1022", name: "M. REKHA",               email: "mrekha.vlsi@suretrust.org",         github_username: "mrekha-vlsi",         username: "mrekha.vlsi",        password: "student123" },
      { student_id: "S1023", name: "M. PENCHALA LIKHITHA",   email: "mlikhitha.vlsi@suretrust.org",      github_username: "mlikhitha-vlsi",      username: "mlikhitha.vlsi",     password: "student123" },
      { student_id: "S1024", name: "MAKTHAL RAHUL RAO",      email: "mrahul.vlsi@suretrust.org",         github_username: "mrahul-vlsi",         username: "mrahul.vlsi",        password: "student123" },
      { student_id: "S1025", name: "MANIDEEP EMMADI",        email: "memmadi.vlsi@suretrust.org",        github_username: "memmadi-vlsi",        username: "memmadi.vlsi",       password: "student123" },
      { student_id: "S1026", name: "MANOJ KUMAR",            email: "manojkumar.vlsi@suretrust.org",     github_username: "manojkumar-vlsi",     username: "manojkumar.vlsi",    password: "student123" },
      { student_id: "S1027", name: "MOPURI PERSIS",          email: "mpersis.vlsi@suretrust.org",        github_username: "mpersis-vlsi",        username: "mpersis.vlsi",       password: "student123" },
      { student_id: "S1028", name: "MUKESH ROY",             email: "mroy.vlsi@suretrust.org",           github_username: "mroy-vlsi",           username: "mroy.vlsi",          password: "student123" },
      { student_id: "S1029", name: "NAVYA SREE",             email: "navyasree.vlsi@suretrust.org",      github_username: "navyasree-vlsi",      username: "navyasree.vlsi",     password: "student123" },
      { student_id: "S1030", name: "NISHITHA",               email: "nishitha.vlsi@suretrust.org",       github_username: "nishitha-vlsi",       username: "nishitha.vlsi",      password: "student123" },
      { student_id: "S1031", name: "P. PURUSHOTHAM",         email: "ppurushotham.vlsi@suretrust.org",   github_username: "ppurushotham-vlsi",   username: "ppurushotham.vlsi",  password: "student123" },
      { student_id: "S1032", name: "PADIGE LIKITHA",         email: "plikitha.vlsi@suretrust.org",       github_username: "plikitha-vlsi",       username: "plikitha.vlsi",      password: "student123" },
      { student_id: "S1033", name: "PRASANNA KUMAR C N",     email: "prasananakumar.vlsi@suretrust.org", github_username: "prasananakumar-vlsi", username: "prasananakumar.vlsi",password: "student123" },
      { student_id: "S1034", name: "PRAVEENA",               email: "praveena.vlsi@suretrust.org",       github_username: "praveena-vlsi",       username: "praveena.vlsi",      password: "student123" },
      { student_id: "S1035", name: "R. NANDINI",             email: "rnandini.vlsi@suretrust.org",       github_username: "rnandini-vlsi",       username: "rnandini.vlsi",      password: "student123" },
      { student_id: "S1036", name: "RADHA KUMARI CHALLA",    email: "rchalla.vlsi@suretrust.org",        github_username: "rchalla-vlsi",        username: "rchalla.vlsi",       password: "student123" },
      { student_id: "S1037", name: "RAPURU SRI LAKSHMI",     email: "rsrilakshmi.vlsi@suretrust.org",    github_username: "rsrilakshmi-vlsi",    username: "rsrilakshmi.vlsi",   password: "student123" },
      { student_id: "S1038", name: "RAVINDRANATH",           email: "ravindranath.vlsi@suretrust.org",   github_username: "ravindranath-vlsi",   username: "ravindranath.vlsi",  password: "student123" },
      { student_id: "S1039", name: "REDDY AKSHAYA BATTALA",  email: "rakshaya.vlsi@suretrust.org",       github_username: "rakshaya-vlsi",       username: "rakshaya.vlsi",      password: "student123" },
      { student_id: "S1040", name: "ROHAN DIWAN",            email: "rdiwan.vlsi@suretrust.org",         github_username: "rdiwan-vlsi",         username: "rdiwan.vlsi",        password: "student123" },
      { student_id: "S1041", name: "SASHIDHAR",              email: "sashidhar.vlsi@suretrust.org",      github_username: "sashidhar-vlsi",      username: "sashidhar.vlsi",     password: "student123" },
      { student_id: "S1042", name: "SHASHANK SHARMA",        email: "ssharma.vlsi@suretrust.org",        github_username: "ssharma-vlsi",        username: "ssharma.vlsi",       password: "student123" },
      { student_id: "S1043", name: "SHRAVANA H S",           email: "shravanahs.vlsi@suretrust.org",     github_username: "shravanahs-vlsi",     username: "shravanahs.vlsi",    password: "student123" },
      { student_id: "S1044", name: "SOURABH",                email: "sourabh.vlsi@suretrust.org",        github_username: "sourabh-vlsi",        username: "sourabh.vlsi",       password: "student123" },
      { student_id: "S1045", name: "SUDHEER",                email: "sudheer.vlsi@suretrust.org",        github_username: "sudheer-vlsi",        username: "sudheer.vlsi",       password: "student123" },
      { student_id: "S1046", name: "T. PRADEEP",             email: "tpradeep.vlsi@suretrust.org",       github_username: "tpradeep-vlsi",       username: "tpradeep.vlsi",      password: "student123" },
      { student_id: "S1047", name: "U. VISHNU VARDHAN",      email: "uvishnu.vlsi@suretrust.org",        github_username: "uvishnu-vlsi",        username: "uvishnu.vlsi",       password: "student123" },
      { student_id: "S1048", name: "UMADEVI VAJJA",          email: "uvajja.vlsi@suretrust.org",         github_username: "uvajja-vlsi",         username: "uvajja.vlsi",        password: "student123" },
      { student_id: "S1049", name: "VENKATA PRANAY",         email: "vpranay.vlsi@suretrust.org",        github_username: "vpranay-vlsi",        username: "vpranay.vlsi",       password: "student123" },
      { student_id: "S1050", name: "YASHVANTH H S",          email: "yashvanthhs.vlsi@suretrust.org",    github_username: "yashvanthhs-vlsi",    username: "yashvanthhs.vlsi",   password: "student123" }
    ];
    for (var i = 0; i < seedStudents.length; i++) {
      var std = seedStudents[i];
      std.status = "Active";
      appendObjectToSheet(studentsSheet, ['student_id', 'name', 'email', 'github_username', 'status', 'username', 'password'], std);
    }
    students = seedStudents;
  }

  // Assignments, Submissions, Attendance, Resources all start EMPTY.
  // Attendance is punched manually by the mentor via the LMS.
  return {
    students:    students,
    mentors:     mentors,
    assignments: getSheetDataAsObjects(assignmentsSheet),
    submissions: getSheetDataAsObjects(submissionsSheet),
    attendance:  getSheetDataAsObjects(attendanceSheet),
    resources:   getSheetDataAsObjects(resourcesSheet)
  };
}

/**
 * Returns assignments list.
 */
function getAssignments(ss) {
  var sheet = getOrCreateSheet(ss, "Assignments", ['assignment_id', 'title', 'subject', 'description', 'instructions', 'deadline', 'drive_file_name', 'drive_file_url', 'created_date', 'status', 'allow_late_submissions']);
  return getSheetDataAsObjects(sheet);
}

/**
 * Returns submissions list.
 */
function getSubmissions(ss) {
  var sheet = getOrCreateSheet(ss, "Submissions", ['submission_id', 'assignment_id', 'student_id', 'student_name', 'repo_link', 'commit_hash', 'commit_url', 'submitted_time', 'status', 'marks', 'feedback', 'student_comments']);
  return getSheetDataAsObjects(sheet);
}

/**
 * Returns students list.
 */
function getStudents(ss) {
  var sheet = getOrCreateSheet(ss, "Students", ['student_id', 'name', 'email', 'github_username', 'status', 'username', 'password']);
  return getSheetDataAsObjects(sheet);
}

/**
 * Returns activity log list.
 */
function getLogs(ss) {
  var sheet = getOrCreateSheet(ss, "Logs", ['log_id', 'timestamp', 'action', 'user_id', 'details']);
  return getSheetDataAsObjects(sheet);
}

/**
 * Action: createAssignment
 */
function createAssignment(ss, params) {
  var sheet = getOrCreateSheet(ss, "Assignments", ['assignment_id', 'title', 'subject', 'description', 'instructions', 'deadline', 'drive_file_name', 'drive_file_url', 'created_date', 'status', 'allow_late_submissions']);
  var assignments = getSheetDataAsObjects(sheet);
  
  var assignmentId = "A" + (1000 + assignments.length + 1);
  var fileUrl = params.drive_file_url || "";
  var fileName = params.drive_file_name || "";
  
  // Handle optional base64 upload directly into Google Drive
  if (params.fileData && params.fileName) {
    try {
      var folderName = params.driveFolderName || "LMS_Assignments";
      var driveFile = saveFileToDrive(params.fileName, params.fileData, folderName);
      fileUrl = driveFile.url;
      fileName = driveFile.name;
    } catch (uploadError) {
      Logger.log("Drive upload failed: " + uploadError.toString());
      throw new Error("Failed to save assignment file to Drive: " + uploadError.toString());
    }
  }
  
  var newAssignment = {
    assignment_id: assignmentId,
    title: params.title || "Untitled Assignment",
    subject: params.subject || "General",
    description: params.description || "",
    instructions: params.instructions || "",
    deadline: params.deadline || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    drive_file_name: fileName,
    drive_file_url: fileUrl,
    created_date: new Date().toISOString(),
    status: params.status || "Active",
    allow_late_submissions: params.allow_late_submissions || "false"
  };
  
  appendObjectToSheet(sheet, ['assignment_id', 'title', 'subject', 'description', 'instructions', 'deadline', 'drive_file_name', 'drive_file_url', 'created_date', 'status', 'allow_late_submissions'], newAssignment);
  logAction(ss, "CREATE_ASSIGNMENT", params.creator_id || "Mentor", "Created assignment: " + newAssignment.title + " (" + assignmentId + ")");
  
  return newAssignment;
}

/**
 * Action: submitAssignment
 */
function submitAssignment(ss, params) {
  var submissionsSheet = getOrCreateSheet(ss, "Submissions", ['submission_id', 'assignment_id', 'student_id', 'student_name', 'repo_link', 'commit_hash', 'commit_url', 'submitted_time', 'status', 'marks', 'feedback', 'student_comments']);
  var studentsSheet = getOrCreateSheet(ss, "Students", ['student_id', 'name', 'email', 'github_username', 'status', 'username', 'password']);
  
  var assignmentId = params.assignment_id;
  var studentId = params.student_id;
  
  if (!assignmentId || !studentId) {
    throw new Error("Missing parameters: assignment_id and student_id are required.");
  }
  
  // Look up student name
  var students = getSheetDataAsObjects(studentsSheet);
  var studentName = "Unknown Student";
  for (var i = 0; i < students.length; i++) {
    if (students[i].student_id === studentId) {
      studentName = students[i].name;
      break;
    }
  }
  
  // Format git commit url if not provided but repo and commit hash are present
  var commitUrl = params.commit_url || "";
  if (!commitUrl && params.repo_link && params.commit_hash) {
    var repoClean = params.repo_link.replace(/\.git$/, "");
    if (repoClean.indexOf("github.com") !== -1) {
      commitUrl = repoClean + "/commit/" + params.commit_hash;
    }
  }
  
  var submissions = getSheetDataAsObjects(submissionsSheet);
  var existingSubmission = null;
  for (var j = 0; j < submissions.length; j++) {
    if (submissions[j].assignment_id === assignmentId && submissions[j].student_id === studentId) {
      existingSubmission = submissions[j];
      break;
    }
  }
  
  var submissionData = {
    repo_link: params.repo_link || "",
    commit_hash: params.commit_hash || "",
    commit_url: commitUrl,
    submitted_time: new Date().toISOString(),
    status: params.status || "Submitted",
    marks: "",       // Reset marks for review
    feedback: "",     // Reset feedback
    student_comments: params.student_comments || ""
  };
  
  var headers = ['submission_id', 'assignment_id', 'student_id', 'student_name', 'repo_link', 'commit_hash', 'commit_url', 'submitted_time', 'status', 'marks', 'feedback', 'student_comments'];
  
  if (existingSubmission) {
    updateRowInSheet(submissionsSheet, headers, "submission_id", existingSubmission.submission_id, submissionData);
    submissionData.submission_id = existingSubmission.submission_id;
    submissionData.assignment_id = assignmentId;
    submissionData.student_id = studentId;
    submissionData.student_name = studentName;
    logAction(ss, "RESUBMIT_ASSIGNMENT", studentId, "Updated submission for " + assignmentId);
  } else {
    var submissionId = "SUB" + (1000 + submissions.length + 1);
    submissionData.submission_id = submissionId;
    submissionData.assignment_id = assignmentId;
    submissionData.student_id = studentId;
    submissionData.student_name = studentName;
    appendObjectToSheet(submissionsSheet, headers, submissionData);
    logAction(ss, "SUBMIT_ASSIGNMENT", studentId, "Submitted assignment " + assignmentId);
  }
  
  return submissionData;
}

/**
 * Action: reviewSubmission
 */
function reviewSubmission(ss, params) {
  var submissionsSheet = getOrCreateSheet(ss, "Submissions", ['submission_id', 'assignment_id', 'student_id', 'student_name', 'repo_link', 'commit_hash', 'commit_url', 'submitted_time', 'status', 'marks', 'feedback']);
  var reviewsSheet = getOrCreateSheet(ss, "Reviews", ['review_id', 'submission_id', 'mentor_id', 'review_time', 'marks', 'feedback', 'status']);
  
  var submissionId = params.submission_id;
  var marks = params.marks;
  var feedback = params.feedback || "";
  var status = params.status || "Reviewed"; // Reviewed or Resubmission Requested
  var mentorId = params.mentor_id || "Mentor";
  
  if (!submissionId) {
    throw new Error("Missing parameter: submission_id is required.");
  }
  
  var marksNum = Number(marks);
  if (isNaN(marksNum) || marksNum < 0 || marksNum > 100) {
    throw new Error("Marks must be between 0 and 100.");
  }
  
  var submissionHeaders = ['submission_id', 'assignment_id', 'student_id', 'student_name', 'repo_link', 'commit_hash', 'commit_url', 'submitted_time', 'status', 'marks', 'feedback', 'student_comments'];
  
  // Update submission status in main Submissions sheet
  var ok = updateRowInSheet(submissionsSheet, submissionHeaders, "submission_id", submissionId, {
    marks: marks,
    feedback: feedback,
    status: status
  });
  
  if (!ok) {
    throw new Error("Submission not found: " + submissionId);
  }
  
  // Log into Reviews sheet for history
  var reviews = getSheetDataAsObjects(reviewsSheet);
  var reviewId = "R" + (1000 + reviews.length + 1);
  var newReview = {
    review_id: reviewId,
    submission_id: submissionId,
    mentor_id: mentorId,
    review_time: new Date().toISOString(),
    marks: marks,
    feedback: feedback,
    status: status
  };
  
  appendObjectToSheet(reviewsSheet, ['review_id', 'submission_id', 'mentor_id', 'review_time', 'marks', 'feedback', 'status'], newReview);
  logAction(ss, "GRADE_SUBMISSION", mentorId, "Graded submission " + submissionId + " | Score: " + marks + " | Status: " + status);
  
  return newReview;
}

/**
 * Action: registerStudent
 */
function registerStudent(ss, params) {
  var headers = ['student_id', 'name', 'email', 'github_username', 'status', 'username', 'password'];
  var sheet = getOrCreateSheet(ss, "Students", headers);
  var students = getSheetDataAsObjects(sheet);
  
  var studentId = params.student_id;
  var name = params.name;
  var email = params.email;
  var githubUsername = params.github_username || "";
  var username = params.username || (email ? email.split("@")[0] : "");
  var password = params.password || "student123";
  
  if (!name || !email) {
    throw new Error("Missing parameters: name and email are required to register.");
  }
  
  var existingStudent = null;
  if (studentId) {
    for (var i = 0; i < students.length; i++) {
      if (students[i].student_id === studentId) {
        existingStudent = students[i];
        break;
      }
    }
  } else {
    // Find by email
    for (var i = 0; i < students.length; i++) {
      if (students[i].email.toLowerCase() === email.toLowerCase()) {
        existingStudent = students[i];
        studentId = students[i].student_id;
        break;
      }
    }
  }
  
  var studentData = {
    name: name,
    email: email,
    github_username: githubUsername,
    status: existingStudent ? (existingStudent.status || "Active") : "Active",
    username: username,
    password: password
  };
  
  if (existingStudent) {
    // Keep existing password/username if not explicitly updated
    if (!params.username && existingStudent.username) studentData.username = existingStudent.username;
    if (!params.password && existingStudent.password) studentData.password = existingStudent.password;
    
    updateRowInSheet(sheet, headers, "student_id", studentId, studentData);
    studentData.student_id = studentId;
    logAction(ss, "UPDATE_STUDENT", studentId, "Updated student profile: " + name);
  } else {
    studentId = "S" + (1000 + students.length + 1);
    studentData.student_id = studentId;
    appendObjectToSheet(sheet, headers, studentData);
    logAction(ss, "REGISTER_STUDENT", studentId, "Registered student: " + name);
  }
  
  return studentData;
}

/**
 * Action: saveAttendance
 */
function saveAttendance(ss, params) {
  var sheet = getOrCreateSheet(ss, "Attendance", ['student_id', 'date', 'status']);
  var date = params.date;
  var records = params.records; // Array of {student_id, date, status}
  
  if (!date || !records) {
    throw new Error("Missing parameters: date and records are required.");
  }
  
  var headers = ['student_id', 'date', 'status'];
  var valuesRange = sheet.getDataRange();
  var values = valuesRange.getValues();
  var headersRow = values[0];
  var studentIdIdx = headersRow.indexOf("student_id");
  var dateIdx = headersRow.indexOf("date");
  
  for (var i = 0; i < records.length; i++) {
    var rec = records[i];
    var found = false;
    
    for (var r = 1; r < values.length; r++) {
      var cellDateStr = "";
      if (values[r][dateIdx] instanceof Date) {
        cellDateStr = values[r][dateIdx].toISOString().split('T')[0];
      } else {
        cellDateStr = String(values[r][dateIdx]).split('T')[0];
      }
      var recDateStr = rec.date.split('T')[0];
      
      if (String(values[r][studentIdIdx]) === String(rec.student_id) && cellDateStr === recDateStr) {
        sheet.getRange(r + 1, headersRow.indexOf("status") + 1).setValue(rec.status);
        found = true;
        break;
      }
    }
    
    if (!found) {
      appendObjectToSheet(sheet, headers, {
        student_id: rec.student_id,
        date: rec.date,
        status: rec.status
      });
    }
  }
  
  logAction(ss, "SAVE_ATTENDANCE", "Mentor", "Logged attendance for " + date + " | Present: " + params.present + " | Absent: " + params.absent);
  return { date: date, success: true };
}

// ============================================
// EDIT ASSIGNMENT
// ============================================
function editAssignment(ss, params) {
  var sheet = ss.getSheetByName("Assignments");
  if (!sheet) throw new Error("Assignments sheet not found");
  
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  
  var updateObj = {};
  if (params.title) updateObj.title = params.title;
  if (params.subject) updateObj.subject = params.subject;
  if (params.description !== undefined) updateObj.description = params.description;
  if (params.instructions !== undefined) updateObj.instructions = params.instructions;
  if (params.deadline) updateObj.deadline = params.deadline;
  if (params.status) updateObj.status = params.status;
  if (params.drive_file_url !== undefined) updateObj.drive_file_url = params.drive_file_url;
  if (params.allow_late_submissions !== undefined) updateObj.allow_late_submissions = params.allow_late_submissions;
  
  var updated = updateRowInSheet(sheet, headers, "assignment_id", params.assignment_id, updateObj);
  
  if (!updated) throw new Error("Assignment not found: " + params.assignment_id);
  
  logAction(ss, "EDIT_ASSIGNMENT", "Mentor", "Updated assignment: " + params.assignment_id + " | Fields: " + Object.keys(updateObj).join(", "));
  return { assignment_id: params.assignment_id, updated: true };
}

// ============================================
// DELETE ASSIGNMENT
// ============================================
function deleteAssignment(ss, params) {
  var sheet = ss.getSheetByName("Assignments");
  if (!sheet) throw new Error("Assignments sheet not found");
  
  var deleted = deleteRowFromSheet(sheet, "assignment_id", params.assignment_id);
  if (!deleted) throw new Error("Assignment not found: " + params.assignment_id);
  
  // Cascade delete submissions for this assignment
  var submissionsSheet = ss.getSheetByName("Submissions");
  if (submissionsSheet) {
    var subRange = submissionsSheet.getDataRange();
    var subValues = subRange.getValues();
    if (subValues.length > 1) {
      var subHeaders = subValues[0];
      var subMatchColIdx = subHeaders.indexOf("assignment_id");
      if (subMatchColIdx !== -1) {
        for (var i = subValues.length - 1; i >= 1; i--) {
          if (String(subValues[i][subMatchColIdx]) === String(params.assignment_id)) {
            submissionsSheet.deleteRow(i + 1);
          }
        }
      }
    }
  }
  
  logAction(ss, "DELETE_ASSIGNMENT", "Mentor", "Deleted assignment: " + params.assignment_id);
  return { assignment_id: params.assignment_id, deleted: true };
}

function deleteRowFromSheet(sheet, matchColName, matchVal) {
  var range = sheet.getDataRange();
  var values = range.getValues();
  if (values.length <= 1) return false;
  
  var headersRow = values[0];
  var matchColIdx = headersRow.indexOf(matchColName);
  if (matchColIdx === -1) return false;
  
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][matchColIdx]) === String(matchVal)) {
      sheet.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

// ============================================
// RESOURCE SHARING
// ============================================
function shareResource(ss, params) {
  var sheet = getOrCreateSheet(ss, "Resources", ['resource_id', 'title', 'type', 'url', 'created_date', 'shared_by']);
  var resources = getSheetDataAsObjects(sheet);
  
  var resourceId = "RES" + (1000 + resources.length + 1);
  var fileUrl = params.drive_file_url || "";
  
  // Handle optional base64 upload directly into Google Drive
  if (params.fileData && params.fileName) {
    try {
      var folderName = params.driveFolderName || "LMS_Resources";
      var driveFile = saveFileToDrive(params.fileName, params.fileData, folderName);
      fileUrl = driveFile.url;
    } catch (uploadError) {
      Logger.log("Drive upload failed: " + uploadError.toString());
      throw new Error("Failed to save resource file to Drive: " + uploadError.toString());
    }
  }
  
  var newResource = {
    resource_id: resourceId,
    title: params.title || "Untitled Resource",
    type: params.type || "Link",
    url: fileUrl,
    created_date: new Date().toISOString(),
    shared_by: params.shared_by || "Mentor"
  };
  
  appendObjectToSheet(sheet, ['resource_id', 'title', 'type', 'url', 'created_date', 'shared_by'], newResource);
  logAction(ss, "SHARE_RESOURCE", params.shared_by || "Mentor", "Shared resource: " + newResource.title + " (" + resourceId + ")");
  
  return newResource;
}

function deleteResource(ss, params) {
  var sheet = ss.getSheetByName("Resources");
  if (!sheet) throw new Error("Resources sheet not found");
  
  var deleted = deleteRowFromSheet(sheet, "resource_id", params.resource_id);
  if (!deleted) throw new Error("Resource not found: " + params.resource_id);
  
  logAction(ss, "DELETE_RESOURCE", "Mentor", "Deleted resource: " + params.resource_id);
  return { resource_id: params.resource_id, deleted: true };
}

function toggleStudentStatus(ss, params) {
  var sheet = ss.getSheetByName("Students");
  if (!sheet) throw new Error("Students sheet not found");
  
  var range = sheet.getDataRange();
  var values = range.getValues();
  if (values.length <= 1) throw new Error("No students found");
  
  var headersRow = values[0];
  var idIdx = headersRow.indexOf("student_id");
  var statusIdx = headersRow.indexOf("status");
  
  if (idIdx === -1 || statusIdx === -1) {
    throw new Error("Required columns 'student_id' or 'status' not found in Students sheet");
  }
  
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idIdx]) === String(params.student_id)) {
      sheet.getRange(i + 1, statusIdx + 1).setValue(params.status || "Active");
      logAction(ss, "TOGGLE_STUDENT_STATUS", "Mentor", "Changed status of student " + params.student_id + " to " + (params.status || "Active"));
      return { student_id: params.student_id, status: params.status || "Active", updated: true };
    }
  }
  
  throw new Error("Student not found: " + params.student_id);
}

/**
 * Adds a custom menu to the spreadsheet when opened.
 */
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('LMS Admin')
      .addItem('Setup / Reset Database Sheets', 'setupDatabase')
      .addToUi();
}

/**
 * Initializes/Creates all required sheets and their column headers.
 */
function setupDatabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Create sheets and headers
  getOrCreateSheet(ss, "Students",    ['student_id', 'name', 'email', 'github_username', 'status', 'username', 'password']);
  getOrCreateSheet(ss, "Mentors",     ['mentor_id', 'name', 'email', 'status', 'username', 'password']);
  getOrCreateSheet(ss, "Assignments", ['assignment_id', 'title', 'subject', 'description', 'instructions', 'deadline', 'drive_file_name', 'drive_file_url', 'created_date', 'status', 'allow_late_submissions']);
  getOrCreateSheet(ss, "Submissions", ['submission_id', 'assignment_id', 'student_id', 'student_name', 'repo_link', 'commit_hash', 'commit_url', 'submitted_time', 'status', 'marks', 'feedback', 'student_comments']);
  getOrCreateSheet(ss, "Attendance",  ['student_id', 'date', 'status']);
  getOrCreateSheet(ss, "Resources",   ['resource_id', 'title', 'type', 'url', 'created_date', 'shared_by']);
  getOrCreateSheet(ss, "Logs",        ['log_id', 'timestamp', 'action', 'user_id', 'details']);
  getOrCreateSheet(ss, "Reviews",     ['review_id', 'submission_id', 'mentor_id', 'review_time', 'marks', 'feedback', 'status']);

  // Run initial data getter to trigger the student seeding if empty
  getInitialData(ss);
  
  try {
    SpreadsheetApp.getUi().alert("LMS Database Sheets & Column Headers successfully initialized!");
  } catch (e) {
    Logger.log("Database initialized. Sheet UI not available: " + e.message);
  }
}

/**
 * Handles the callback from Hugging Face Space autograder to update student grades.
 * Implement LockService to prevent write collisions.
 */
function autogradingCallback(ss, params) {
  if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!params) {
    Logger.log("Manually run from editor: No parameters provided.");
    return "This function is triggered automatically by the autograder.";
  }
  var lock = LockService.getScriptLock();
  try {
    // Acquire a lock that waits up to 30 seconds before failing
    lock.waitLock(30000);
    
    var sheet = ss.getSheetByName("Submissions");
    if (!sheet) throw new Error("Submissions sheet not found");
    
    var range = sheet.getDataRange();
    var values = range.getValues();
    if (values.length <= 1) throw new Error("No submissions found to update");
    
    var headers = values[0];
    var studentIdIdx = headers.indexOf("student_id");
    var commitHashIdx = headers.indexOf("commit_hash");
    var statusIdx = headers.indexOf("status");
    var marksIdx = headers.indexOf("marks");
    var feedbackIdx = headers.indexOf("feedback");
    
    if (studentIdIdx === -1 || commitHashIdx === -1) {
      throw new Error("Required sheet columns are missing from Submissions schema");
    }
    
    var studentId = String(params.student_id).trim();
    var commitHash = String(params.commit_hash).trim();
    
    // Search for the matching placeholder submission row
    var foundRowIndex = -1;
    for (var i = 1; i < values.length; i++) {
      var rowStudentId = String(values[i][studentIdIdx]).trim();
      var rowCommitHash = String(values[i][commitHashIdx]).trim();
      
      if (rowStudentId === studentId && rowCommitHash === commitHash) {
        foundRowIndex = i + 1; // 1-indexed row number
        break;
      }
    }
    
    if (foundRowIndex === -1) {
      throw new Error("No matching placeholder submission found for student: " + studentId + " and commit: " + commitHash);
    }
    
    // Parse Qwen grading feedback format "[Score]/100 | [Feedback]" or "[Score]/10 | [Feedback]"
    var rawOutput = params.grading_output || "0/100 | No feedback received.";
    var score = 0;
    var maxScore = 100;
    var feedbackText = rawOutput;
    
    var parts = rawOutput.split("|");
    if (parts.length >= 2) {
      feedbackText = parts.slice(1).join("|").trim();
    }
    
    // Parse score from the raw output string (supporting lists or standard formats)
    var scoreMatch = rawOutput.match(/(\d+)\/(100|10)/);
    if (scoreMatch) {
      score = parseInt(scoreMatch[1], 10);
      maxScore = parseInt(scoreMatch[2], 10);
    }
    
    // Map score to /100 percentage for the LMS dashboard grade compatibility
    var marksPercentage = maxScore === 10 ? score * 10 : score;
    marksPercentage = Math.min(100, Math.max(0, marksPercentage));
    
    // Compile complete feedback report including Verilator syntax messages
    var compilerReport = "";
    if (params.compiler_logs) {
      compilerReport = "\n\n----------------------------------------\n[VERILATOR COMPILER OUTPUT]\n" + params.compiler_logs;
    }
    var fullFeedback = feedbackText + compilerReport;
    
    // Write values back to spreadsheet cells
    if (statusIdx !== -1) {
      sheet.getRange(foundRowIndex, statusIdx + 1).setValue("Reviewed");
    }
    if (marksIdx !== -1) {
      sheet.getRange(foundRowIndex, marksIdx + 1).setValue(marksPercentage);
    }
    if (feedbackIdx !== -1) {
      sheet.getRange(foundRowIndex, feedbackIdx + 1).setValue(fullFeedback);
    }
    
    logAction(ss, "AUTOGRADER_CALLBACK", "System", "Graded student " + studentId + " | Score: " + marksPercentage + "%");
    return { success: true, updated_row: foundRowIndex };
    
  } finally {
    // Release the LockService script lock
    lock.releaseLock();
  }
}



