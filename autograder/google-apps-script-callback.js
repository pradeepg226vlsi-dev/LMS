// =========================================================================
// TASK 2: GOOGLE APPS SCRIPT COLLISION-SAFE RECEIVER (Add to google-apps-script.gs)
// =========================================================================

/**
 * Handles the callback from Hugging Face Space autograder to update student grades.
 * Implement LockService to prevent write collisions.
 */
function autogradingCallback(ss, params) {
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
    
    // Parse Qwen grading feedback format "[Score]/10 | [Feedback]"
    var rawOutput = params.grading_output || "0/10 | No feedback received.";
    var score = 0;
    var feedbackText = rawOutput;
    
    var parts = rawOutput.split("|");
    if (parts.length >= 2) {
      var scorePart = parts[0].trim(); // "[Score]/10"
      feedbackText = parts.slice(1).join("|").trim();
      
      var scoreMatch = scorePart.match(/(\d+)\/10/);
      if (scoreMatch) {
        score = parseInt(scoreMatch[1], 10);
      }
    }
    
    // Map score from /10 to /100 percentage for the LMS dashboard grade compatibility
    var marksPercentage = score * 10;
    
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



// =========================================================================
// TASK 3: FRONTEND API WIRING (Add to app.js integration flow)
// =========================================================================

/**
 * Dispatches the Verilog commit details to Hugging Face Autograder Space.
 * Handles the initial pending placeholder state.
 */
async function submitCommitToAutograder(studentId, repoUrl, commitHash, assignmentId) {
  const hfAutograderUrl = "https://pradeepg226vlsi-dev-antigravity-lms-grader.hf.space/grade-commit"; // Replace with your HF Space name
  const appsScriptUrl = state.apiUrl; // Live Google Apps Script API endpoint
  
  try {
    // 1. Submit placeholder record to Google Sheets database with Processing status
    app.showToast("Submitting code receipt to Google Sheets...", "info");
    
    const placeholderPayload = {
      action: "submitAssignment",
      assignment_id: assignmentId,
      student_id: studentId,
      repo_link: repoUrl,
      commit_hash: commitHash,
      commit_url: `${repoUrl}/commit/${commitHash}`
    };
    
    // Set loading indicator on submit button
    const submitBtn = document.getElementById("submit-student-file-btn");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Connecting to Autograder...";
    }
    
    const dbResponse = await fetch(appsScriptUrl, {
      method: "POST",
      body: JSON.stringify(placeholderPayload),
      headers: { "Content-Type": "text/plain" }
    });
    const dbJson = await dbResponse.json();
    if (!dbJson.success) throw new Error("Database error: " + dbJson.error);
    
    app.showToast("Code registered! Triggering Hugging Face Autograder Space...", "info");
    
    // 2. Dispatch to Hugging Face Space Serverless Python execution engine
    const autograderPayload = {
      student_id: studentId,
      repo_url: repoUrl,
      commit_hash: commitHash,
      apps_script_url: appsScriptUrl
    };
    
    // Fire and forget, or wait for background trigger validation
    fetch(hfAutograderUrl, {
      method: "POST",
      body: JSON.stringify(autograderPayload),
      headers: { "Content-Type": "application/json" }
    })
    .then(async (res) => {
      const result = await res.json();
      console.log("Autograder background run initialized:", result);
      app.showToast("Autograder is evaluating your Verilog modules! Status will update shortly.", "success");
    })
    .catch((err) => {
      console.error("Autograder trigger error:", err);
      app.showToast("Autograder connection error. Verification is running in background.", "warning");
    });
    
    // 3. UI update and redirection back to dashboard
    await app.syncData();
    app.showView("student-assignments");
    
  } catch (err) {
    app.showToast("Autograder submission failed: " + err.message, "error");
  } finally {
    const submitBtn = document.getElementById("submit-student-file-btn");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Code Version";
    }
  }
}
