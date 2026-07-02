/**
 * LMS Assignment Tracking System - Application Script
 * Orchestrates routing, State Management, Local Mock Database,
 * and Live Google Apps Script API Connections.
 */

// Deployed Google Apps Script Web App URL
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyHplkN4txNqynCQRvHHSoOA-ZaUW5vzZ0ZkXI1TQ5WjtnashqAuFXMzcllv71Gjs8/exec';


// Application State
const state = {
  apiUrl: APPS_SCRIPT_URL, // Deployed Apps Script URL
  currentRole: 'mentor',   // 'mentor' or student_id (e.g. 'S1001')
  students: [],
  mentors: [],
  assignments: [],
  submissions: [],
  attendance: [],
  logs: [],
  resources: []
};

// ---------------------------------------------------------
// CORE SYSTEM CONTROLLER
// ---------------------------------------------------------
const app = {
  
  async init() {
    this.setupEventListeners();
    
    // 1. Restore session immediately before sync to avoid login screen flashing
    const session = localStorage.getItem('ag_lms_session');
    let hasValidSession = false;
    
    if (session) {
      state.isAuthenticated = true;
      if (session === 'mentor') {
        state.currentRole = 'mentor';
        this.updateProfileUI('Mentor', 'Instructor');
        this.showLoginScreen(false);
        // Show sync loader overlay
        this.showSyncLoader(true);
        hasValidSession = true;
      } else {
        // Temporary student profile until sync finishes
        state.currentRole = session;
        this.updateProfileUI('Student', 'Learner', 'S');
        this.showLoginScreen(false);
        // Show sync loader overlay
        this.showSyncLoader(true);
        hasValidSession = true;
      }
    } else {
      this.showLoginScreen(true);
    }

    // 2. Fetch data
    try {
      await this.syncData();
      this.populateStudentSelector();
      
      // 3. Post-sync session check & detail refinement
      if (hasValidSession) {
        if (session === 'mentor') {
          this.switchRole('mentor');
        } else {
          const student = state.students.find(s => s.student_id === session);
          if (student) {
            if (student.status === 'Suspended') {
              this.handleSuspensionLogout();
              return;
            } else {
              const initials = student.name.substring(0, 2);
              this.updateProfileUI(student.name, 'Learner', initials);
              this.switchRole(session);
            }
          } else if (state.students.length > 0) {
            localStorage.removeItem('ag_lms_session');
            this.showToast('Session expired or student profile not found.', 'warning');
            this.showLoginScreen(true);
          } else {
            // Sync may have failed, still show basic UI
            this.switchRole(session);
          }
        }
      }
    } catch (startupError) {
      console.error('LMS Startup Sync Error:', startupError);
      if (hasValidSession) {
        // Sync failed but session exists — show empty dashboard anyway
        if (session === 'mentor') {
          this.switchRole('mentor');
        } else {
          this.switchRole(session);
        }
      }
    } finally {
      this.showSyncLoader(false);
    }
    
    this.showToast('LMS Platform ready!', 'success');
  },

  showSyncLoader(show) {
    let overlay = document.getElementById('sync-loader-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'sync-loader-overlay';
      overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(28, 33, 40, 0.75); backdrop-filter: blur(4px);
        display: flex; flex-direction: column; align-items: center;
        justify-content: center; z-index: 9999; gap: 1rem;
      `;
      overlay.innerHTML = `
        <div style="width: 44px; height: 44px; border: 4px solid #373e47;
          border-top-color: #539bf5; border-radius: 50%;
          animation: spin 0.8s linear infinite;"></div>
        <span style="color: #adbac7; font-family: 'Plus Jakarta Sans', sans-serif;
          font-size: 0.9rem; font-weight: 500;">Loading your data...</span>
        <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
      `;
      document.body.appendChild(overlay);
    }
    overlay.style.display = show ? 'flex' : 'none';
  },



  // Data Syncing — always fetches from live Google Sheets API
  async syncData() {
    if (!state.apiUrl) {
      this.showToast('Google Sheets API URL is missing.', 'error');
      return;
    }
    
    this.showToast('Syncing with Google Sheets...', 'info');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 40000);
      
      // Must use POST — Google Apps Script strips GET query params on redirect
      const response = await fetch(state.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'getInitialData' }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const json = await response.json();
      
      if (json.success) {
        state.students = (json.data.students || []).map(s => ({ ...s, status: s.status || 'Active' }));
        state.mentors = json.data.mentors || [];
        state.assignments = json.data.assignments || [];
        state.submissions = json.data.submissions || [];
        state.attendance = json.data.attendance || [];
        state.resources = json.data.resources || [];
        this.showToast('Synced with Google Sheets!', 'success');

        // Check if the current user got suspended
        if (state.isAuthenticated && state.currentRole !== 'mentor') {
          const currentStudent = state.students.find(s => s.student_id === state.currentRole);
          if (currentStudent && currentStudent.status === 'Suspended') {
            this.handleSuspensionLogout();
            return;
          }
        }
        
        // Diagnostic Log
        if (state.assignments.length > 0) {
          console.log("LMS Sync Successful. Assignments keys returned from Google Sheets:", Object.keys(state.assignments[0]));
          console.log("Sample assignment data:", state.assignments[0]);
        } else {
          console.log("LMS Sync Successful. No assignments found in database.");
        }
      } else {
        throw new Error(json.error || 'Unknown API error');
      }
    } catch (err) {
      console.error('Google Sheets API Error:', err);
      this.showToast(`Google Sync failed: ${err.message}`, 'error');
    }
  },

  // UI Event Handlers
  setupEventListeners() {
    // Role Switcher
    const roleSelector = document.getElementById('user-role-selector');
    if (roleSelector) {
      roleSelector.addEventListener('change', (e) => {
        const val = e.target.value;
        this.switchRole(val);
      });
    }

    // Login Form Submission
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleLogin();
      });
    }

    // Enter Key Listeners for Login Fields
    const loginEmail = document.getElementById('login-email');
    if (loginEmail) {
      loginEmail.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          await this.handleLogin();
        }
      });
    }

    const loginPassword = document.getElementById('login-password');
    if (loginPassword) {
      loginPassword.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          await this.handleLogin();
        }
      });
    }


    // Logout Button Click
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        this.handleLogout();
      });
    }

    // Student Attendance Modal Toggle
    const attendanceCard = document.getElementById('student-attendance-card');
    if (attendanceCard) {
      attendanceCard.addEventListener('click', () => {
        this.openStudentAttendanceModal();
      });
    }

    const closeAttendanceModalBtn = document.getElementById('close-attendance-modal-btn');
    if (closeAttendanceModalBtn) {
      closeAttendanceModalBtn.addEventListener('click', () => {
        const modal = document.getElementById('student-attendance-modal');
        if (modal) modal.style.display = 'none';
      });
    }

    // Input Event Delegation (Search & Dates)
    document.addEventListener('input', (e) => {
      if (e.target) {
        if (e.target.id === 'mentor-students-search') {
          this.renderMentorStudents();
        } else if (e.target.id === 'student-assignments-search' || e.target.id === 'student-assignments-date') {
          this.renderStudentAssignmentsGrid();
        }
      }
    });

    // Change Event Delegation (Selectors)
    document.addEventListener('change', (e) => {
      if (e.target) {
        if (e.target.id === 'student-assignments-status-filter') {
          this.renderStudentAssignmentsGrid();
        }
      }
    });
    // Attendance Puncher Click Handlers (Delegated)
    document.addEventListener('click', async (e) => {
      if (e.target) {
        if (e.target.id === 'btn-load-attendance') {
          this.renderMentorAttendance();
        } else if (e.target.id === 'btn-save-attendance-punch') {
          await this.saveAttendancePunch();
        }
      }
    });
    // View Switching Navigation
    document.querySelectorAll('.sidebar-nav li').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const view = item.getAttribute('data-view');
        if (view) this.showView(view);
      });
    });



    // Create Assignment Form Submission
    document.getElementById('create-assignment-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleCreateAssignment();
    });

    // Student Submit Assignment Form Submission
    document.getElementById('student-submission-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleStudentSubmit();
    });

    // Share Resource Form Submission
    document.getElementById('share-resource-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleShareResource();
    });

    // Setup Resource Drag and Drop File Upload
    const resFileInput = document.getElementById('res-file-input');
    const resUploadText = document.getElementById('res-upload-status-text');
    const resUploadedName = document.getElementById('res-uploaded-filename');

    if (resFileInput) {
      resFileInput.addEventListener('change', () => {
        if (resFileInput.files.length > 0) {
          resUploadedName.textContent = resFileInput.files[0].name;
          resUploadedName.style.color = 'var(--color-success)';
          resUploadText.textContent = 'File attached and ready for publish!';
        }
      });
    }

    // Mentor Submit Grade Form Submission
    document.getElementById('submit-grade-btn').addEventListener('click', async (e) => {
      e.preventDefault();
      await this.handleMentorGrade();
    });

    // Submissions Status Filter change
    document.getElementById('submission-filter-status').addEventListener('change', () => {
      this.renderMentorSubmissionsTable();
    });

    document.getElementById('assignment-search-input').addEventListener('input', () => {
      this.renderMentorSubmissionsTable();
    });

    document.getElementById('assignment-date-filter').addEventListener('change', () => {
      this.renderMentorSubmissionsTable();
    });

    document.getElementById('back-to-assignments-btn').addEventListener('click', () => {
      document.getElementById('mentor-submissions-detail-view').style.display = 'none';
      document.getElementById('mentor-submissions-grid-view').style.display = 'block';
    });

    document.getElementById('detail-roster-filter').addEventListener('change', () => {
      this.renderDetailRosterTable();
    });

    document.getElementById('detail-roster-search').addEventListener('input', () => {
      this.renderDetailRosterTable();
    });

    document.getElementById('detail-roster-sort').addEventListener('change', () => {
      this.renderDetailRosterTable();
    });


    // Edit Assignment Modal events
    document.getElementById('edit-assignment-btn').addEventListener('click', () => {
      this.openEditAssignmentModal();
    });
    document.getElementById('close-edit-modal-btn').addEventListener('click', () => {
      document.getElementById('edit-assignment-modal').style.display = 'none';
    });
    document.getElementById('cancel-edit-btn').addEventListener('click', () => {
      document.getElementById('edit-assignment-modal').style.display = 'none';
    });
    document.getElementById('edit-assignment-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleEditAssignment();
    });
    document.getElementById('delete-assign-btn').addEventListener('click', async () => {
      const assignmentId = document.getElementById('edit-assign-id').value;
      if (confirm('Are you sure you want to delete this assignment? This will also permanently delete all student submissions for it!')) {
        await this.handleDeleteAssignment(assignmentId);
      }
    });

    // Setup Drag and Drop File Upload
    const dropzone = document.getElementById('drive-upload-dropzone');
    const fileInput = document.getElementById('assign-file-input');
    const uploadText = document.getElementById('upload-status-text');
    const uploadedName = document.getElementById('uploaded-filename');

    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        uploadedName.textContent = fileInput.files[0].name;
        uploadedName.style.color = 'var(--color-success)';
        uploadText.textContent = 'File attached and ready for publish!';
      }
    });

    // Stats Cards Interactive Clicks
    document.getElementById('mentor-card-active').addEventListener('click', () => {
      this.showView('mentor-submissions-tracker');
      document.getElementById('submission-filter-status').value = 'All';
      this.renderMentorSubmissionsTable();
    });

    document.getElementById('mentor-card-pending').addEventListener('click', () => {
      this.showView('mentor-submissions-tracker');
      document.getElementById('submission-filter-status').value = 'Submitted';
      this.renderMentorSubmissionsTable();
    });

    document.getElementById('mentor-card-average').addEventListener('click', () => {
      this.showView('mentor-submissions-tracker');
      document.getElementById('submission-filter-status').value = 'Reviewed';
      this.renderMentorSubmissionsTable();
    });

    // Make stats cards focusable and pressable with Enter/Space keys
    const mentorStatsCardsIds = ['mentor-card-active', 'mentor-card-pending', 'mentor-card-average'];
    mentorStatsCardsIds.forEach(cardId => {
      const cardEl = document.getElementById(cardId);
      if (cardEl) {
        cardEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            cardEl.click();
          }
        });
      }
    });

    // Student Resources Search & Filters
    document.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'student-resources-search') {
        this.renderStudentResources();
      }
    });

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.resource-filter-btn');
      if (btn) {
        document.querySelectorAll('.resource-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.renderStudentResources();
      }
    });
  },





  populateStudentSelector() {
    const optGroup = document.getElementById('student-opt-group');
    if (!optGroup) return;
    optGroup.innerHTML = '';
    
    state.students.forEach(student => {
      const option = document.createElement('option');
      option.value = student.student_id;
      option.textContent = student.name;
      optGroup.appendChild(option);
    });
  },

  // Role Switching Control
  switchRole(roleVal) {
    state.currentRole = roleVal;
    
    const mentorSection = document.getElementById('nav-mentor-section');
    const studentSection = document.getElementById('nav-student-section');
    
    // Hide/show navigation blocks
    if (roleVal === 'mentor') {
      mentorSection.style.display = 'block';
      studentSection.style.display = 'none';
      
      // Default to Mentor Dashboard view
      this.showView('mentor-dashboard');
      this.showToast('Logged in as Mentor', 'info');
    } else {
      mentorSection.style.display = 'none';
      studentSection.style.display = 'block';
      
      // Default to Student Dashboard view
      this.showView('student-dashboard');
      const student = state.students.find(s => s.student_id === roleVal);
      this.showToast(`Logged in as ${student ? student.name : 'Student'}`, 'info');
    }
  },

  // SPA Views Controller
  showView(viewId) {
    // 1. Enforce Navigation Guards / Role Based Access Control
    if (state.isAuthenticated) {
      const mentorViews = ['mentor-dashboard', 'mentor-create-assignment', 'mentor-assignments', 'mentor-submissions-tracker', 'mentor-code-review', 'mentor-resources', 'mentor-students', 'mentor-attendance'];
      const studentViews = ['student-dashboard', 'student-assignments', 'student-submit-pane', 'student-performance', 'student-resources'];
      
      if (state.currentRole === 'mentor') {
        if (studentViews.includes(viewId)) {
          this.showView('mentor-dashboard');
          return;
        }
      } else {
        if (mentorViews.includes(viewId)) {
          this.showView('student-dashboard');
          return;
        }
      }
    } else {
      this.showLoginScreen(true);
      return;
    }

    // Deactivate all nav items
    document.querySelectorAll('.sidebar-nav li').forEach(li => {
      li.classList.remove('active');
    });

    // Deactivate all sections
    document.querySelectorAll('.view-section').forEach(sec => {
      sec.classList.remove('active');
    });

    // Make view active
    const targetSection = document.getElementById(`view-${viewId}`);
    if (targetSection) {
      targetSection.classList.add('active');
    }

    // Mark nav item active
    const activeNavItem = document.querySelector(`.sidebar-nav li[data-view="${viewId}"]`);
    if (activeNavItem) {
      activeNavItem.classList.add('active');
    }

    // Reset sub-views in Submissions Tracker
    if (viewId === 'mentor-submissions-tracker') {
      document.getElementById('mentor-submissions-detail-view').style.display = 'none';
      document.getElementById('mentor-submissions-grid-view').style.display = 'block';
    }

    // Set page title (including Dynamic greetings)
    const pageTitle = document.getElementById('page-title');
    if (viewId === 'mentor-dashboard') {
      const hours = new Date().getHours();
      let greeting = 'Good Morning';
      if (hours >= 12 && hours < 16) greeting = 'Good Afternoon';
      else if (hours >= 16 || hours < 4) greeting = 'Good Evening';
      pageTitle.textContent = `${greeting}, Mentor`;
    } else if (viewId === 'student-dashboard') {
      const hours = new Date().getHours();
      let greeting = 'Good Morning';
      if (hours >= 12 && hours < 16) greeting = 'Good Afternoon';
      else if (hours >= 16 || hours < 4) greeting = 'Good Evening';
      const student = state.students.find(s => s.student_id === state.currentRole);
      const nameStr = student ? student.name : 'Learner';
      pageTitle.textContent = `${greeting}, ${nameStr}`;
    } else {
      pageTitle.textContent = this.getViewTitle(viewId);
    }

    // Call dynamic renders
    this.renderViewData(viewId);
  },

  getViewTitle(viewId) {
    const titles = {
      'mentor-dashboard': 'Mentor Admin Panel',
      'mentor-create-assignment': 'Publish Assignment Document',
      'mentor-assignments': 'Assignment Manager Control',
      'mentor-submissions-tracker': 'Learner Submissions Hub',
      'mentor-code-review': 'Submissions / Evaluate Version',
      'mentor-resources': 'Shared Resource Manager',
      'mentor-students': 'Student Account Control',
      'mentor-attendance': 'Class Attendance Register',
      'student-dashboard': 'My Academic Overview',
      'student-assignments': 'Available Class Tasks',
      'student-submit-pane': 'Task Submission Panel',
      'student-performance': 'Grades & Academic Feedback',
      'student-resources': 'Shared Resource Center'
    };
    return titles[viewId] || 'LMS Portal';
  },

  renderViewData(viewId) {
    switch (viewId) {
      case 'mentor-dashboard':
        this.renderMentorDashboard();
        break;
      case 'mentor-assignments':
        this.renderMentorAssignmentManager();
        break;
      case 'mentor-submissions-tracker':
        this.renderMentorSubmissionsTable();
        break;
      case 'mentor-resources':
        this.renderMentorResources();
        break;
      case 'mentor-students':
        this.renderMentorStudents();
        break;
      case 'mentor-attendance':
        this.renderMentorAttendance();
        break;

      case 'student-dashboard':
        this.renderStudentDashboard();
        break;
      case 'student-assignments':
        this.renderStudentAssignmentsGrid();
        break;
      case 'student-performance':
        this.renderStudentPerformanceTable();
        break;
      case 'student-resources':
        this.renderStudentResources();
        break;
    }
  },

  // ---------------------------------------------------------
  // MENTOR VIEWS RENDERING & ACTIONS
  // ---------------------------------------------------------
  
  renderMentorDashboard() {
    // Calculators
    const activeAssigns = state.assignments.filter(a => a.status === 'Active').length;
    const awaitingReview = state.submissions.filter(s => s.status === 'Submitted').length;
    
    // Average
    const gradedSubmissions = state.submissions.filter(s => s.status === 'Reviewed' && s.marks !== "");
    let classAverage = "-";
    if (gradedSubmissions.length > 0) {
      const sum = gradedSubmissions.reduce((acc, curr) => acc + Number(curr.marks), 0);
      classAverage = Math.round(sum / gradedSubmissions.length) + "%";
    }

    // Update layout elements
    document.getElementById('mentor-stat-active-assignments').textContent = activeAssigns;
    document.getElementById('mentor-stat-pending-reviews').textContent = awaitingReview;
    document.getElementById('mentor-stat-average-grade').textContent = classAverage;

    // Render Awaiting Review Table
    const tableBody = document.getElementById('mentor-dashboard-pending-table');
    tableBody.innerHTML = '';
    
    const pendingSubmissions = state.submissions.filter(s => s.status === 'Submitted');
    
    if (pendingSubmissions.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-tertiary);">No pending submissions to review. Excellent job!</td></tr>`;
      return;
    }

    pendingSubmissions.forEach(sub => {
      const assignment = state.assignments.find(a => a.assignment_id === sub.assignment_id);
      const row = document.createElement('tr');
      row.innerHTML = `
        <td style="font-weight:600;">${sub.student_name}</td>
        <td>${assignment ? assignment.title : sub.assignment_id}</td>
        <td>${new Date(sub.submitted_time).toLocaleString()}</td>
        <td><a href="${sub.repo_link}" target="_blank" style="color: var(--color-primary); font-size: 0.85rem;">${sub.repo_link}</a></td>
        <td><button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;" onclick="app.openGradingPanel('${sub.submission_id}')">Evaluate</button></td>
      `;
      tableBody.appendChild(row);
    });
  },

  renderMentorSubmissionsTable() {
    const filter = document.getElementById('submission-filter-status').value;
    const searchQuery = document.getElementById('assignment-search-input').value.toLowerCase().trim();
    const dateQuery = document.getElementById('assignment-date-filter').value;
    const gridContainer = document.getElementById('mentor-assignments-stats-grid');
    gridContainer.innerHTML = '';
    
    // Hide detail view by default when drawing the grid
    document.getElementById('mentor-submissions-detail-view').style.display = 'none';
    document.getElementById('mentor-submissions-grid-view').style.display = 'block';

    if (state.assignments.length === 0) {
      gridContainer.innerHTML = `
        <div class="section-panel" style="grid-column: 1 / -1; text-align: center; padding: 3rem; color: var(--text-tertiary);">
          No assignments have been created yet. Publish an assignment document to get started.
        </div>
      `;
      return;
    }

    let renderedCards = 0;

    state.assignments.forEach(task => {
      // Find all submissions matching this assignment
      const allSubs = state.submissions.filter(s => s.assignment_id === task.assignment_id);
      const pendingReviews = allSubs.filter(s => s.status === 'Submitted').length;
      const lateSubmissions = allSubs.filter(s => new Date(s.submitted_time) > new Date(task.deadline)).length;
      const resubmitCount = allSubs.filter(s => s.status === 'Resubmission Requested').length;
      
      // Filter the cards grid based on selection
      if (task.status === 'Draft') return;
      
      const reviewedCount = allSubs.filter(s => s.status === 'Reviewed').length;
      if (filter === 'Submitted' && pendingReviews === 0) return;
      if (filter === 'Reviewed' && reviewedCount === 0) return;
      
      // Recent (last 7 days)
      if (filter === 'Recent') {
        const createdDate = task.created_date ? new Date(task.created_date) : new Date();
        const diffTime = Math.abs(new Date() - createdDate);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (diffDays > 7) return;
      }

      // Filter by Search Query (Title, Subject, or Description)
      if (searchQuery) {
        const titleMatch = task.title.toLowerCase().includes(searchQuery);
        const subjectMatch = task.subject.toLowerCase().includes(searchQuery);
        const descMatch = task.description.toLowerCase().includes(searchQuery);
        if (!titleMatch && !subjectMatch && !descMatch) return;
      }

      // Filter by Calendar Date (matches deadline date or creation date)
      if (dateQuery) {
        const getLocalDateString = (dateVal) => {
          if (!dateVal) return '';
          try {
            const d = new Date(dateVal);
            if (isNaN(d.getTime())) return '';
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
          } catch (e) {
            return '';
          }
        };
        const taskDeadlineStr = getLocalDateString(task.deadline);
        const taskCreatedStr = getLocalDateString(task.created_date);
        if (taskDeadlineStr !== dateQuery && taskCreatedStr !== dateQuery) return;
      }

      renderedCards++;

      const card = document.createElement('div');
      card.className = 'stat-card';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `Assignment: ${task.title}. Total submissions: ${allSubs.length}. Click to view details.`);
      card.style.cursor = 'pointer';
      card.style.display = 'flex';
      card.style.flexDirection = 'column';
      card.style.minHeight = '340px';

      // Build status badge for this card
      const statusColors = { Active: 'var(--color-primary)', Draft: 'var(--color-warning)', Closed: 'var(--color-danger)' };
      const statusBgs = { Active: 'rgba(83,155,245,0.12)', Draft: 'rgba(251,191,36,0.12)', Closed: 'rgba(239,68,68,0.12)' };
      const cardStatus = task.status || 'Active';

      card.innerHTML = `
        <div class="stat-header">
          <span style="font-size: 0.72rem; text-transform: uppercase; font-weight: 700; color: var(--color-primary);">${task.subject}</span>
          <span style="font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 0.2rem 0.55rem; border-radius: 999px; background: ${statusBgs[cardStatus]}; color: ${statusColors[cardStatus]}; border: 1px solid ${statusColors[cardStatus]}33;">${cardStatus}</span>
        </div>
        
        <div class="stat-desc" style="font-weight: 700; color: #ffffff; font-size: 1.05rem; line-height: 1.3; margin: 0.5rem 0 0.25rem 0;">${task.title}</div>
        
        <p style="font-size: 0.78rem; color: var(--text-secondary); line-height: 1.4; margin: 0.25rem 0 0.75rem 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis; min-height: 2.2rem;">
          ${task.description || 'No description provided.'}
        </p>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; font-size: 0.75rem; color: var(--text-tertiary); margin: 0.5rem 0; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 0.5rem;">
          <div><strong>Assigned Date:</strong><br>${task.created_date ? new Date(task.created_date).toLocaleDateString() : '1/07/2026'}</div>
          <div><strong>Deadline:</strong><br>${new Date(task.deadline).toLocaleDateString()}</div>
        </div>

        <div style="margin-top: auto; font-size: 0.72rem; color: var(--text-secondary); display: flex; flex-direction: column; gap: 0.35rem; border-top: 1px solid var(--border-color); padding-top: 0.5rem;">
          <div style="display: flex; justify-content: space-between;">
            <span>Total Registered Students:</span>
            <strong style="color: #ffffff;">50</strong>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Total Submissions:</span>
            <strong style="color: #ffffff;">${allSubs.length}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; padding-left: 0.75rem; border-left: 2px solid rgba(255,255,255,0.1);">
            <span>Awaiting Review:</span>
            <strong style="color: var(--color-warning);">${pendingReviews}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; padding-left: 0.75rem; border-left: 2px solid rgba(255,255,255,0.1);">
            <span>Reviewed Submissions:</span>
            <strong style="color: var(--color-success);">${reviewedCount}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; padding-left: 0.75rem; border-left: 2px solid rgba(255,255,255,0.1);">
            <span>Resubmissions Requested:</span>
            <strong style="color: #ff6b6b;">${resubmitCount}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; border-top: 1px dashed rgba(255,255,255,0.05); padding-top: 0.25rem;">
            <span>Late Submissions:</span>
            <strong style="color: var(--color-danger);">${lateSubmissions}</strong>
          </div>
        </div>
      `;

      // Click and keyboard interaction
      const openDetail = () => {
        this.openAssignmentDetail(task.assignment_id);
      };

      card.addEventListener('click', openDetail);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDetail();
        }
      });

      gridContainer.appendChild(card);
    });

    if (renderedCards === 0) {
      gridContainer.innerHTML = `
        <div class="section-panel" style="grid-column: 1 / -1; text-align: center; padding: 3rem; color: var(--text-tertiary);">
          No assignments match the selected search or filter criteria.
        </div>
      `;
    }
  },

  openAssignmentDetail(assignmentId) {
    // Hide grid, show detail panel
    document.getElementById('mentor-submissions-grid-view').style.display = 'none';
    document.getElementById('mentor-submissions-detail-view').style.display = 'block';

    const task = state.assignments.find(a => a.assignment_id === assignmentId);
    if (!task) return;

    // Cache the active assignment ID for the filter to use
    state.activeDetailAssignmentId = assignmentId;

    // Reset filter, search query, and sort on every fresh open
    document.getElementById('detail-roster-filter').value = 'all';
    document.getElementById('detail-roster-search').value = '';
    document.getElementById('detail-roster-sort').value = 'default';

    // Set header details
    document.getElementById('detail-assignment-title').textContent = task.title;
    document.getElementById('detail-assignment-subject').textContent = task.subject;
    document.getElementById('detail-assignment-deadline').textContent = `Deadline: ${new Date(task.deadline).toLocaleString()}`;
    document.getElementById('detail-assignment-description').textContent = task.description || '';

    // Get submissions for this assignment
    const subs = state.submissions.filter(s => s.assignment_id === assignmentId);
    
    // Separate into On-Time and Late for counting stats
    const onTimeCount = subs.filter(s => new Date(s.submitted_time) <= new Date(task.deadline)).length;
    const lateCount = subs.filter(s => new Date(s.submitted_time) > new Date(task.deadline)).length;

    // Find Missing (not submitted) students count
    const submittedStudentIds = new Set(subs.map(s => s.student_id));
    const missingCount = state.students.filter(stud => !submittedStudentIds.has(stud.student_id)).length;

    // Update statistics counters
    document.getElementById('detail-count-ontime').textContent = onTimeCount;
    document.getElementById('detail-count-late').textContent = lateCount;
    document.getElementById('detail-count-missing').textContent = missingCount;

    // Render the roster table
    this.renderDetailRosterTable();
  },

  renderDetailRosterTable() {
    const assignmentId = state.activeDetailAssignmentId;
    if (!assignmentId) return;

    const task = state.assignments.find(a => a.assignment_id === assignmentId);
    if (!task) return;

    const filter = document.getElementById('detail-roster-filter').value;
    const tbody = document.getElementById('detail-roster-table-body');
    tbody.innerHTML = '';

    // Get all submissions for this assignment
    const subs = state.submissions.filter(s => s.assignment_id === assignmentId);
    
    // Create combined data of all students + their submission statuses
    let roster = state.students.map(student => {
      const sub = subs.find(s => s.student_id === student.student_id);
      
      let studentStatus = 'awaited'; // default status
      let isLate = false;
      
      if (sub) {
        isLate = new Date(sub.submitted_time) > new Date(task.deadline);
        if (sub.status === 'Reviewed') {
          studentStatus = 'reviewed';
        } else if (sub.status === 'Resubmission Requested') {
          studentStatus = 'resubmit';
        } else {
          studentStatus = 'submitted'; // awaiting review
        }
      }

      return {
        student,
        submission: sub,
        status: studentStatus,
        isLate
      };
    });

    // Apply Filter logic
    if (filter !== 'all') {
      roster = roster.filter(item => {
        if (filter === 'awaited') return !item.submission;
        if (filter === 'submitted') return item.submission && item.submission.status === 'Submitted';
        if (filter === 'reviewed') return item.submission && item.submission.status === 'Reviewed';
        if (filter === 'resubmit') return item.submission && item.submission.status === 'Resubmission Requested';
        if (filter === 'late') return item.isLate;
        return true;
      });
    }

    // Apply Search Query filter logic
    const searchQuery = document.getElementById('detail-roster-search').value.toLowerCase().trim();
    if (searchQuery) {
      roster = roster.filter(item => {
        const nameMatch = item.student.name.toLowerCase().includes(searchQuery);
        const idMatch = item.student.student_id.toLowerCase().includes(searchQuery);
        return nameMatch || idMatch;
      });
    }

    // Apply Sorting logic
    const sortVal = document.getElementById('detail-roster-sort').value;
    if (sortVal === 'marks-desc') {
      // Sort highest marks first, missing/unrated at bottom
      roster.sort((a, b) => {
        const marksA = a.submission && a.submission.marks !== "" ? Number(a.submission.marks) : -1;
        const marksB = b.submission && b.submission.marks !== "" ? Number(b.submission.marks) : -1;
        return marksB - marksA;
      });
    } else if (sortVal === 'marks-asc') {
      // Sort lowest marks first, missing/unrated at bottom
      roster.sort((a, b) => {
        const marksA = a.submission && a.submission.marks !== "" ? Number(a.submission.marks) : 999;
        const marksB = b.submission && b.submission.marks !== "" ? Number(b.submission.marks) : 999;
        return marksA - marksB;
      });
    } else if (sortVal === 'name-asc') {
      // Sort A-Z
      roster.sort((a, b) => a.student.name.localeCompare(b.student.name));
    } else if (sortVal === 'date-desc') {
      // Sort newest submission first
      roster.sort((a, b) => {
        const dateA = a.submission ? new Date(a.submission.submitted_time) : new Date(0);
        const dateB = b.submission ? new Date(b.submission.submitted_time) : new Date(0);
        return dateB - dateA;
      });
    }

    if (roster.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-tertiary); padding: 2rem 0;">No students match the selected filter.</td></tr>`;
      return;
    }

    // Draw the unified rows
    roster.forEach(item => {
      const stud = item.student;
      const sub = item.submission;
      
      let timeHtml = '-';
      let repoHtml = '-';
      let shaHtml = '-';
      let statusHtml = '<span class="card-badge" style="background: rgba(140, 140, 140, 0.12); color: var(--text-secondary); border: 1px solid rgba(140, 140, 140, 0.22);">Awaiting Submission</span>';
      let marksHtml = '-';
      let actionHtml = '-';

      if (sub) {
        const isLate = item.isLate;
        const lateBadgeHtml = isLate ? `<span class="card-badge" style="background: rgba(229, 83, 75, 0.12); color: var(--color-danger); border: 1px solid rgba(229, 83, 75, 0.25); font-size: 0.65rem; padding: 0.1rem 0.35rem; margin-left: 0.35rem; font-weight: 700;">LATE</span>` : '';
        timeHtml = `${new Date(sub.submitted_time).toLocaleString()}${lateBadgeHtml}`;
        repoHtml = `<a href="${sub.repo_link}" target="_blank" style="color: var(--color-primary); font-size: 0.85rem;">Repository Link</a>`;
        shaHtml = `<span style="font-family: monospace; font-size: 0.8rem;">${sub.commit_hash}</span>`;
        
        let statusClass = 'status-submitted';
        if (sub.status === 'Reviewed') statusClass = 'status-reviewed';
        if (sub.status === 'Resubmission Requested') statusClass = 'status-closed';
        statusHtml = `<span class="card-badge ${statusClass}">${sub.status}</span>`;
        
        marksHtml = sub.marks !== "" ? `${sub.marks}/100` : "-";
        
        actionHtml = `
          <button class="btn btn-secondary" style="padding: 0.35rem 0.75rem; font-size: 0.8rem;" onclick="app.openGradingPanel('${sub.submission_id}')">
            ${sub.status === 'Reviewed' ? 'Review Again' : 'Evaluate'}
          </button>
        `;
      }

      const row = document.createElement('tr');
      row.innerHTML = `
        <td style="font-weight: 600; color: #ffffff;">${stud.name} <span style="font-family: monospace; font-size: 0.75rem; color: var(--text-secondary); font-weight: normal; margin-left: 0.35rem;">(${stud.student_id})</span></td>
        <td>${timeHtml}</td>
        <td>${repoHtml}</td>
        <td>${shaHtml}</td>
        <td>${statusHtml}</td>
        <td style="font-weight: 700; color: #ffffff;">${marksHtml}</td>
        <td>${actionHtml}</td>
      `;
      tbody.appendChild(row);
    });
  },



  // Open Grading Center
  openGradingPanel(submissionId) {
    const sub = state.submissions.find(s => s.submission_id === submissionId);
    if (!sub) return;

    this.showView('mentor-code-review');
    
    document.getElementById('grade-student-name').textContent = sub.student_name;
    document.getElementById('grade-assignment-id').textContent = sub.assignment_id;
    document.getElementById('grade-submitted-time').textContent = new Date(sub.submitted_time).toLocaleString();
    
    const repoLink = document.getElementById('grade-repo-link');
    repoLink.href = sub.repo_link;
    repoLink.textContent = sub.repo_link;

    document.getElementById('grade-commit-hash').textContent = sub.commit_hash;
    
    const commitUrl = document.getElementById('grade-commit-url');
    if (sub.commit_url) {
      commitUrl.href = sub.commit_url;
      commitUrl.style.display = 'inline-flex';
    } else {
      commitUrl.style.display = 'none';
    }

    document.getElementById('grade-submission-id').value = sub.submission_id;
    document.getElementById('grade-marks').value = sub.marks || '';
    document.getElementById('grade-status').value = sub.status === 'Resubmission Requested' ? 'Resubmission Requested' : 'Reviewed';
    document.getElementById('grade-feedback').value = sub.feedback || '';
  },

  // Action: Create Assignment
  async handleCreateAssignment() {
    const title = document.getElementById('assign-title').value;
    const subject = document.getElementById('assign-subject').value;
    const description = document.getElementById('assign-desc').value;
    const instructions = document.getElementById('assign-instructions').value;
    const deadline = document.getElementById('assign-deadline').value;
    const initialStatus = document.getElementById('assign-status').value;
    const fileUrlRaw = document.getElementById('assign-drive-url').value;
    
    const allowLateVal = document.getElementById('assign-allow-late').checked ? 'true' : 'false';
    
    const fileInput = document.getElementById('assign-file-input');
    const submitBtn = document.getElementById('submit-assignment-btn');
    
    submitBtn.disabled = true;
    submitBtn.textContent = 'Publishing to Drive & Sheets...';
    
    let base64Data = null;
    let fileName = null;
    
    // Read file as base64
    if (fileInput.files.length > 0) {
      const file = fileInput.files[0];
      fileName = file.name;
      base64Data = await this.readFileAsBase64(file);
    }

    const payload = {
      action: 'createAssignment',
      title,
      subject,
      description,
      instructions,
      deadline: new Date(deadline).toISOString(),
      status: initialStatus,
      allow_late_submissions: allowLateVal,
      drive_file_url: fileUrlRaw,
      drive_file_name: fileName || '',
      fileData: base64Data,
      fileName: fileName,
      creator_id: 'Mentor'
    };

    try {
      const response = await fetch(state.apiUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'text/plain' }
      });
      const json = await response.json();
      if (!json.success) throw new Error(json.error);
      
      this.showToast('Successfully published assignment to Drive and Sheets Database!', 'success');
      
      // Reset Form & Redirect
      document.getElementById('create-assignment-form').reset();
      document.getElementById('uploaded-filename').textContent = 'No file selected';
      document.getElementById('upload-status-text').textContent = 'Click or drag a file to upload directly to Drive folder';
      
      await this.syncData();
      this.showView('mentor-dashboard');
      
    } catch (err) {
      console.error(err);
      this.showToast(`Publishing failed: ${err.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Publish Assignment';
    }
  },

  // Action: Grade submission
  async handleMentorGrade() {
    const submissionId = document.getElementById('grade-submission-id').value;
    const marks = document.getElementById('grade-marks').value;
    const status = document.getElementById('grade-status').value;
    const feedback = document.getElementById('grade-feedback').value;
    
    const submitBtn = document.getElementById('submit-grade-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting Grade...';

    const payload = {
      action: 'reviewSubmission',
      submission_id: submissionId,
      marks: Number(marks),
      status,
      feedback,
      mentor_id: 'Mentor'
    };

    try {
      const response = await fetch(state.apiUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'text/plain' }
      });
      const json = await response.json();
      if (!json.success) throw new Error(json.error);
      
      this.showToast('Review and Grades logged successfully!', 'success');
      
      await this.syncData();
      if (state.activeDetailAssignmentId) {
        this.showView('mentor-submissions-tracker');
        this.openAssignmentDetail(state.activeDetailAssignmentId);
      } else {
        this.showView('mentor-submissions-tracker');
      }
      
    } catch (err) {
      this.showToast(`Grading failed: ${err.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Grading & Log Result';
    }
  },

  // Open Edit Assignment Modal
  openEditAssignmentModal() {
    const assignmentId = state.activeDetailAssignmentId;
    if (!assignmentId) return;

    const task = state.assignments.find(a => a.assignment_id === assignmentId);
    if (!task) return;

    // Populate form fields
    document.getElementById('edit-assign-id').value = task.assignment_id;
    document.getElementById('edit-assign-title').value = task.title;
    document.getElementById('edit-assign-subject').value = task.subject;
    document.getElementById('edit-assign-desc').value = task.description || '';
    document.getElementById('edit-assign-instructions').value = task.instructions || '';
    document.getElementById('edit-assign-status').value = task.status || 'Active';
    document.getElementById('edit-assign-drive-url').value = task.drive_file_url || '';
    
    // Set checkbox
    const allowLate = String(task.allow_late_submissions).toLowerCase() === 'true';
    console.log(`Edit Modal: Task allow_late_submissions raw value from sheet is [${task.allow_late_submissions}]. Setting checkbox to:`, allowLate);
    document.getElementById('edit-assign-allow-late').checked = allowLate;

    // Format deadline for datetime-local input (YYYY-MM-DDTHH:mm)
    if (task.deadline) {
      const dt = new Date(task.deadline);
      const pad = n => String(n).padStart(2, '0');
      const formatted = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
      document.getElementById('edit-assign-deadline').value = formatted;
    }

    document.getElementById('edit-assignment-modal').style.display = 'flex';
  },

  // Action: Save Edited Assignment
  async handleEditAssignment() {
    const assignmentId = document.getElementById('edit-assign-id').value;
    const task = state.assignments.find(a => a.assignment_id === assignmentId);
    if (!task) return;

    const saveBtn = document.getElementById('save-edit-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    const updatedFields = {
      title: document.getElementById('edit-assign-title').value,
      subject: document.getElementById('edit-assign-subject').value,
      description: document.getElementById('edit-assign-desc').value,
      instructions: document.getElementById('edit-assign-instructions').value,
      deadline: new Date(document.getElementById('edit-assign-deadline').value).toISOString(),
      status: document.getElementById('edit-assign-status').value,
      drive_file_url: document.getElementById('edit-assign-drive-url').value,
      allow_late_submissions: document.getElementById('edit-assign-allow-late').checked ? 'true' : 'false'
    };

    try {
      const payload = {
        action: 'editAssignment',
        assignment_id: assignmentId,
        ...updatedFields
      };
      console.log("Sending Edit Assignment payload to Google Sheets:", payload);
      
      const response = await fetch(state.apiUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'text/plain' }
      });
      const json = await response.json();
      console.log("Edit Assignment response from Google Sheets:", json);
      
      if (!json.success) throw new Error(json.error);
      this.showToast('Assignment updated in Google Sheets!', 'success');

      await this.syncData();

      // Close modal and refresh the detail view
      document.getElementById('edit-assignment-modal').style.display = 'none';
      this.openAssignmentDetail(assignmentId);

    } catch (err) {
      this.showToast(`Update failed: ${err.message}`, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
    }
  },

  // Render Mentor Assignment Manager Dashboard
  renderMentorAssignmentManager() {
    const activeCount = state.assignments.filter(a => a.status === 'Active').length;
    const draftCount = state.assignments.filter(a => a.status === 'Draft' || !a.status).length;
    const closedCount = state.assignments.filter(a => a.status === 'Closed').length;

    document.getElementById('mgr-count-active').textContent = activeCount;
    document.getElementById('mgr-count-draft').textContent = draftCount;
    document.getElementById('mgr-count-closed').textContent = closedCount;

    const tbody = document.getElementById('assignment-manager-table-body');
    tbody.innerHTML = '';

    if (state.assignments.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-tertiary); padding: 2rem;">No assignments created yet. Click "New Assignment" to start.</td></tr>`;
      return;
    }

    state.assignments.forEach(task => {
      const allSubs = state.submissions.filter(s => s.assignment_id === task.assignment_id);
      const pendingReviews = allSubs.filter(s => s.status === 'Submitted').length;
      const reviewed = allSubs.filter(s => s.status === 'Reviewed').length;
      const resubmits = allSubs.filter(s => s.status === 'Resubmission Requested').length;

      const row = document.createElement('tr');

      // Status badges styling
      const statusColors = { Active: 'var(--color-primary)', Draft: 'var(--color-warning)', Closed: 'var(--color-danger)' };
      const statusBgs = { Active: 'rgba(83,155,245,0.12)', Draft: 'rgba(251,191,36,0.12)', Closed: 'rgba(239,68,68,0.12)' };
      const statusText = task.status || 'Active';
      const statusBadge = `<span style="font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 0.2rem 0.55rem; border-radius: 999px; background: ${statusBgs[statusText]}; color: ${statusColors[statusText]}; border: 1px solid ${statusColors[statusText]}33;">${statusText}</span>`;

      // Quick action button based on state
      let quickActionBtn = '';
      if (statusText === 'Draft') {
        quickActionBtn = `<button class="btn btn-primary" style="padding: 0.3rem 0.6rem; font-size: 0.75rem;" onclick="app.changeAssignmentStatus('${task.assignment_id}', 'Active')">Publish</button>`;
      } else if (statusText === 'Active') {
        quickActionBtn = `<button class="btn btn-danger" style="padding: 0.3rem 0.6rem; font-size: 0.75rem; background-color: var(--color-danger); border-color: var(--color-danger);" onclick="app.changeAssignmentStatus('${task.assignment_id}', 'Closed')">Close</button>`;
      } else if (statusText === 'Closed') {
        quickActionBtn = `<button class="btn btn-success" style="padding: 0.3rem 0.6rem; font-size: 0.75rem; background-color: var(--color-success); border-color: var(--color-success);" onclick="app.changeAssignmentStatus('${task.assignment_id}', 'Active')">Reopen</button>`;
      }

      row.innerHTML = `
        <td style="font-weight: 600; color: #ffffff;">${task.title}</td>
        <td>${task.subject}</td>
        <td>${statusBadge}</td>
        <td>${new Date(task.deadline).toLocaleString()}</td>
        <td>
          <span style="font-weight: 700; color: #ffffff;">${allSubs.length}</span> Submissions
          <div style="font-size: 0.7rem; color: var(--text-secondary); margin-top: 0.1rem;">
            Awaiting: <span style="color: var(--color-warning);">${pendingReviews}</span> | 
            Reviewed: <span style="color: var(--color-success);">${reviewed}</span> | 
            Resubmits: <span style="color: #ff6b6b;">${resubmits}</span>
          </div>
        </td>
        <td>
          <div style="display: flex; gap: 0.4rem; align-items: center;">
            ${quickActionBtn}
            <button class="btn btn-secondary" style="padding: 0.3rem 0.6rem; font-size: 0.75rem;" onclick="state.activeDetailAssignmentId='${task.assignment_id}'; app.openEditAssignmentModal();">Edit</button>
            <button class="btn btn-danger" style="padding: 0.3rem 0.6rem; font-size: 0.75rem; background-color: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2); color: var(--color-danger);" onclick="if(confirm('Are you sure you want to delete this assignment and all student submissions?')){ app.handleDeleteAssignment('${task.assignment_id}') }">Delete</button>
          </div>
        </td>
      `;
      tbody.appendChild(row);
    });
  },

  // Action: Change Assignment Status (Active / Draft / Closed)
  async changeAssignmentStatus(assignmentId, newStatus) {
    const task = state.assignments.find(a => a.assignment_id === assignmentId);
    if (!task) return;

    try {
      const payload = {
        action: 'editAssignment',
        assignment_id: assignmentId,
        status: newStatus
      };
      const response = await fetch(state.apiUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'text/plain' }
      });
      const json = await response.json();
      if (!json.success) throw new Error(json.error);
      this.showToast(`Assignment status updated to ${newStatus}!`, 'success');

      await this.syncData();
      
      // Refresh current view if we are on assignment manager or detail tracker
      const activeNav = document.querySelector('.sidebar-nav .nav-item.active');
      if (activeNav) {
        const viewId = activeNav.getAttribute('data-view');
        this.renderViewData(viewId);
      }
    } catch (err) {
      this.showToast(`Failed to change status: ${err.message}`, 'error');
    }
  },

  // Action: Delete Assignment and its cascading submissions
  async handleDeleteAssignment(assignmentId) {
    const task = state.assignments.find(a => a.assignment_id === assignmentId);
    if (!task) return;

    try {
      const payload = {
        action: 'deleteAssignment',
        assignment_id: assignmentId
      };
      const response = await fetch(state.apiUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'text/plain' }
      });
      const json = await response.json();
      if (!json.success) throw new Error(json.error);
      this.showToast('Assignment and submissions deleted from Google Sheets!', 'success');

      // Close modal if open
      document.getElementById('edit-assignment-modal').style.display = 'none';

      await this.syncData();

      // Go back to the assignment manager
      this.showView('mentor-assignments');

    } catch (err) {
      this.showToast(`Deletion failed: ${err.message}`, 'error');
    }
  },

  renderMentorAttendance() {
    const rosterEl = document.getElementById('attendance-puncher-roster');
    if (!rosterEl) return;
    
    // Set default date to today in local timezone if empty
    const dateInput = document.getElementById('attendance-class-date');
    if (dateInput && !dateInput.value) {
      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      dateInput.value = `${year}-${month}-${day}`;
    }
    
    const selectedDate = dateInput.value;
    rosterEl.innerHTML = '';
    
    // Get all active (non-suspended) students
    const activeStudents = state.students.filter(s => s.status !== 'Suspended');
    
    if (activeStudents.length === 0) {
      rosterEl.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-tertiary); padding: 2rem;">No active students found in roster.</td></tr>`;
      return;
    }
    
    // Build lookup map for student status on selectedDate
    const attendanceMap = {};
    state.attendance.forEach(rec => {
      const recDateOnly = rec.date.split('T')[0];
      if (recDateOnly === selectedDate) {
        attendanceMap[rec.student_id] = rec.status; // 'Present' or 'Absent'
      }
    });
    
    activeStudents.forEach(student => {
      const currentStatus = attendanceMap[student.student_id] || 'Present'; // default to Present
      const isPresent = currentStatus === 'Present';
      
      const row = document.createElement('tr');
      row.setAttribute('data-student-id', student.student_id);
      
      row.innerHTML = `
        <td style="font-family: monospace; font-weight: 500;">${student.student_id}</td>
        <td style="font-weight: 600; color: #ffffff;">${student.name}</td>
        <td>${student.email}</td>
        <td style="text-align: center;">
          <div style="display: flex; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 20px; padding: 2px; width: 180px; margin: 0 auto; overflow: hidden; position: relative;">
            <button type="button" class="btn-attendance-toggle ${isPresent ? 'active-present' : ''}" 
              data-status="Present"
              style="flex: 1; border: none; background: ${isPresent ? 'var(--color-success)' : 'transparent'}; color: ${isPresent ? '#ffffff' : 'var(--text-secondary)'}; font-size: 0.75rem; font-weight: 700; padding: 0.35rem 0.75rem; border-radius: 18px; cursor: pointer; transition: all 0.2s;"
              onclick="app.setAttendanceRowStatus(this, 'Present')">Present</button>
            <button type="button" class="btn-attendance-toggle ${!isPresent ? 'active-absent' : ''}" 
              data-status="Absent"
              style="flex: 1; border: none; background: ${!isPresent ? 'var(--color-danger)' : 'transparent'}; color: ${!isPresent ? '#ffffff' : 'var(--text-secondary)'}; font-size: 0.75rem; font-weight: 700; padding: 0.35rem 0.75rem; border-radius: 18px; cursor: pointer; transition: all 0.2s;"
              onclick="app.setAttendanceRowStatus(this, 'Absent')">Absent</button>
          </div>
        </td>
      `;
      rosterEl.appendChild(row);
    });
    
    this.updateAttendanceSummary();
  },
  
  setAttendanceRowStatus(buttonEl, status) {
    const parentContainer = buttonEl.parentElement;
    const buttons = parentContainer.querySelectorAll('.btn-attendance-toggle');
    
    buttons.forEach(btn => {
      btn.classList.remove('active-present', 'active-absent');
      btn.style.background = 'transparent';
      btn.style.color = 'var(--text-secondary)';
    });
    
    if (status === 'Present') {
      buttonEl.classList.add('active-present');
      buttonEl.style.background = 'var(--color-success)';
      buttonEl.style.color = '#ffffff';
    } else {
      buttonEl.classList.add('active-absent');
      buttonEl.style.background = 'var(--color-danger)';
      buttonEl.style.color = '#ffffff';
    }
    
    this.updateAttendanceSummary();
  },
  
  updateAttendanceSummary() {
    const rosterEl = document.getElementById('attendance-puncher-roster');
    if (!rosterEl) return;
    
    let presentCount = 0;
    let absentCount = 0;
    
    const rows = rosterEl.querySelectorAll('tr');
    rows.forEach(row => {
      const activeBtn = row.querySelector('.btn-attendance-toggle.active-present, .btn-attendance-toggle.active-absent');
      if (activeBtn) {
        const status = activeBtn.getAttribute('data-status');
        if (status === 'Present') presentCount++;
        else if (status === 'Absent') absentCount++;
      } else {
        presentCount++;
      }
    });
    
    document.getElementById('attendance-punch-summary-present').textContent = presentCount;
    document.getElementById('attendance-punch-summary-absent').textContent = absentCount;
  },

  async saveAttendancePunch() {
    const dateInput = document.getElementById('attendance-class-date');
    if (!dateInput || !dateInput.value) {
      this.showToast('Please select a session date first.', 'error');
      return;
    }
    
    const selectedDate = dateInput.value;
    const rosterEl = document.getElementById('attendance-puncher-roster');
    if (!rosterEl) return;
    
    const rows = rosterEl.querySelectorAll('tr');
    if (rows.length === 0) return;
    
    const saveBtn = document.getElementById('btn-save-attendance-punch');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Punching...';
    
    const records = [];
    let presentCount = 0;
    let absentCount = 0;
    
    rows.forEach(row => {
      const studentId = row.getAttribute('data-student-id');
      const activeBtn = row.querySelector('.btn-attendance-toggle.active-present, .btn-attendance-toggle.active-absent');
      let status = 'Present';
      
      if (activeBtn) {
        status = activeBtn.getAttribute('data-status');
      }
      
      if (status === 'Present') presentCount++;
      else absentCount++;
      
      records.push({
        student_id: studentId,
        date: selectedDate,
        status: status
      });
    });
    
    try {
      const payload = {
        action: 'saveAttendance',
        date: selectedDate,
        records: records,
        present: presentCount,
        absent: absentCount
      };
      
      const response = await fetch(state.apiUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'text/plain' }
      });
      
      const json = await response.json();
      if (!json.success) throw new Error(json.error);
      
      this.showToast(`Attendance punched in Google Sheets for ${selectedDate}!`, 'success');
      
      await this.syncData();
      this.renderMentorAttendance();
      
    } catch (err) {
      this.showToast(`Punching attendance failed: ${err.message}`, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save & Punch Attendance';
    }
  },

  // Helper file base64 reader
  readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = error => reject(error);
      reader.readAsDataURL(file);
    });
  },


  // ---------------------------------------------------------
  // STUDENT VIEWS RENDERING & ACTIONS
  // ---------------------------------------------------------
  
  renderStudentDashboard() {
    const studentId = state.currentRole;
    
    // Student specific list
    const mySubmissions = state.submissions.filter(s => s.student_id === studentId);
    
    // Count stats
    const completed = mySubmissions.filter(s => s.status === 'Reviewed').length;
    const pending = mySubmissions.filter(s => s.status === 'Submitted').length;
    
    // Compute remaining or actions required (not started + resubmission requested)
    const activeAssignments = state.assignments.filter(a => a.status === 'Active');
    let todoCount = 0;
    
    activeAssignments.forEach(assign => {
      const sub = mySubmissions.find(s => s.assignment_id === assign.assignment_id);
      if (!sub || sub.status === 'Resubmission Requested') {
        todoCount++;
      }
    });

    // Calculate Attendance rate
    const myAttendance = state.attendance.filter(a => a.student_id === studentId);
    let attendancePercent = 100;
    if (myAttendance.length > 0) {
      const presentCount = myAttendance.filter(a => a.status === 'Present').length;
      attendancePercent = Math.round((presentCount / myAttendance.length) * 100);
    }

    document.getElementById('student-stat-completed').textContent = completed;
    document.getElementById('student-stat-pending').textContent = pending;
    document.getElementById('student-stat-todo').textContent = todoCount;
    document.getElementById('student-stat-attendance').textContent = attendancePercent + "%";

    // Animate and color-code the attendance progress bar
    const attendanceBar = document.getElementById('student-attendance-bar');
    if (attendanceBar) {
      attendanceBar.style.width = attendancePercent + "%";
      if (attendancePercent >= 90) {
        attendanceBar.style.background = 'var(--success-gradient)';
      } else if (attendancePercent >= 75) {
        attendanceBar.style.background = 'var(--warning-gradient)';
      } else {
        attendanceBar.style.background = 'var(--danger-gradient)';
      }
    }

    // Calculate Grade Average for Ring Chart
    const gradedSubmissions = mySubmissions.filter(s => s.status === 'Reviewed' && s.marks !== "");
    let averageGrade = 0;
    
    if (gradedSubmissions.length > 0) {
      const sum = gradedSubmissions.reduce((acc, curr) => acc + Number(curr.marks), 0);
      averageGrade = Math.round(sum / gradedSubmissions.length);
    }

    // Animate Average Grade Circle Ring
    const textNode = document.getElementById('student-avg-percent');
    textNode.textContent = averageGrade + "%";
    
    const ring = document.getElementById('student-avg-ring');
    // Circumference = 2 * PI * r = 2 * 3.14159 * 36 = 226
    const maxOffset = 226;
    const strokeOffset = maxOffset - (averageGrade / 100) * maxOffset;
    
    // Apply stroke dashoffset
    ring.style.strokeDashoffset = strokeOffset;

    // Render grades history chart
    this.renderStudentGradesChart(studentId);
  },

  openStudentAttendanceModal() {
    const studentId = state.currentRole;
    const student = state.students.find(s => s.student_id === studentId);
    const studentName = student ? student.name : studentId;
    
    const modal = document.getElementById('student-attendance-modal');
    if (!modal) return;
    
    // Fill student name
    document.getElementById('attendance-modal-student-name').textContent = studentName;
    
    // Compute rate
    const myAttendance = state.attendance.filter(a => a.student_id === studentId);
    let attendancePercent = 100;
    if (myAttendance.length > 0) {
      const presentCount = myAttendance.filter(a => a.status === 'Present').length;
      attendancePercent = Math.round((presentCount / myAttendance.length) * 100);
    }
    
    const rateEl = document.getElementById('attendance-modal-rate');
    rateEl.textContent = attendancePercent + "%";
    
    // Color code the rate
    if (attendancePercent >= 90) {
      rateEl.style.color = 'var(--color-success)';
    } else if (attendancePercent >= 75) {
      rateEl.style.color = 'var(--color-warning)';
    } else {
      rateEl.style.color = 'var(--color-danger)';
    }
    
    // Populate logs list
    const listEl = document.getElementById('attendance-logs-list');
    listEl.innerHTML = '';
    
    if (myAttendance.length === 0) {
      listEl.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-tertiary);">No attendance records found for this course.</div>`;
    } else {
      // Sort records chronologically (newest first)
      const sortedAttendance = [...myAttendance].sort((a, b) => new Date(b.date) - new Date(a.date));
      
      sortedAttendance.forEach(record => {
        const isPresent = record.status === 'Present';
        const badgeColor = isPresent ? 'var(--color-success)' : 'var(--color-danger)';
        const badgeBg = isPresent ? 'rgba(87, 171, 90, 0.15)' : 'rgba(229, 83, 75, 0.15)';
        const statusLetter = isPresent ? 'P' : 'A';
        
        const row = document.createElement('div');
        row.style.cssText = `
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.75rem 0.5rem;
          border-bottom: 1px solid var(--border-color);
        `;
        
        row.innerHTML = `
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <div style="width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.8rem; background: ${badgeBg}; color: ${badgeColor};">${statusLetter}</div>
            <div>
              <div style="font-weight: 600; font-size: 0.88rem; color: #ffffff;">${record.status}</div>
              <div style="font-size: 0.75rem; color: var(--text-secondary);">Class Session</div>
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 0.85rem; font-weight: 500; color: #ffffff;">${new Date(record.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</div>
            <div style="font-size: 0.72rem; color: var(--text-secondary);">10:00 AM (Scheduled)</div>
          </div>
        `;
        listEl.appendChild(row);
      });
    }
    
    modal.style.display = 'flex';
  },

  renderStudentAssignmentsGrid() {
    const studentId = state.currentRole;
    const grid = document.getElementById('student-assignments-grid');
    grid.innerHTML = '';
    
    // Get filter input values
    const searchInput = document.getElementById('student-assignments-search');
    const searchVal = searchInput ? searchInput.value.trim().toLowerCase() : '';
    
    const dateInput = document.getElementById('student-assignments-date');
    const dateVal = dateInput ? dateInput.value : '';
    
    const statusFilter = document.getElementById('student-assignments-status-filter');
    const statusFilterVal = statusFilter ? statusFilter.value : 'All';
    
    // Only display active and closed assignments (hide Draft)
    let visibleTasks = state.assignments.filter(a => a.status === 'Active' || a.status === 'Closed');
    
    // Apply Text Search Filter (Title or Subject)
    if (searchVal) {
      visibleTasks = visibleTasks.filter(task => 
        task.title.toLowerCase().includes(searchVal) || 
        task.subject.toLowerCase().includes(searchVal)
      );
    }
    
    // Apply Date Filter (Deadline matching local timezone date)
    if (dateVal) {
      const getLocalDateString = (dateValStr) => {
        if (!dateValStr) return '';
        try {
          const d = new Date(dateValStr);
          if (isNaN(d.getTime())) return '';
          const year = d.getFullYear();
          const month = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          return `${year}-${month}-${day}`;
        } catch (e) {
          return '';
        }
      };
      
      visibleTasks = visibleTasks.filter(task => {
        const taskDeadlineStr = getLocalDateString(task.deadline);
        return taskDeadlineStr === dateVal;
      });
    }
    
    // Apply Status Filter
    if (statusFilterVal !== 'All') {
      visibleTasks = visibleTasks.filter(task => {
        const sub = state.submissions.find(s => s.assignment_id === task.assignment_id && s.student_id === studentId);
        if (statusFilterVal === 'Unsubmitted') {
          return !sub;
        } else {
          return sub && sub.status === statusFilterVal;
        }
      });
    }
    
    if (visibleTasks.length === 0) {
      grid.innerHTML = `
        <div class="section-panel" style="grid-column: 1 / -1; text-align: center; padding: 3rem; color: var(--text-tertiary);">
          No assignments match the selected search or filter criteria.
        </div>
      `;
      return;
    }

    visibleTasks.forEach(task => {
      const sub = state.submissions.find(s => s.assignment_id === task.assignment_id && s.student_id === studentId);
      
      const card = document.createElement('div');
      card.className = 'content-card';
      if (task.status === 'Closed') {
        card.style.opacity = '0.85';
      }
      card.setAttribute('tabindex', '0');
      card.setAttribute('role', 'article');
      card.setAttribute('aria-labelledby', `card-title-${task.assignment_id}`);
      
      // Accessibility: Trigger submit modal when pressing Enter or Space
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          app.openSubmitPanel(task.assignment_id);
        }
      });
      
      // Determine status label & styles
      let statusBadgeHtml = `<span class="card-badge status-closed">Not Started</span>`;
      let actionBtnText = 'Submit Assignment';
      let actionBtnClass = 'btn-primary';
      let isReviewed = false;

      const isDeadlinePassed = new Date() > new Date(task.deadline);
      const isLateAllowed = String(task.allow_late_submissions).toLowerCase() === 'true';
      
      if (sub) {
        if (sub.status === 'Submitted') {
          statusBadgeHtml = `<span class="card-badge status-submitted">Awaiting Review</span>`;
          actionBtnText = 'Update Submission';
          actionBtnClass = 'btn-secondary';
        } else if (sub.status === 'Reviewed') {
          statusBadgeHtml = `<span class="card-badge status-reviewed">Reviewed (Grade: ${sub.marks}%)</span>`;
          actionBtnText = 'Submission Locked';
          actionBtnClass = 'btn-secondary';
          isReviewed = true;
        } else if (sub.status === 'Resubmission Requested') {
          statusBadgeHtml = `<span class="card-badge status-closed" style="background: hsla(0, 84%, 60%, 0.15); color: var(--color-danger);">Resubmission Required</span>`;
          actionBtnText = 'Submit Fixes';
          actionBtnClass = 'btn-success';
        }
      }

      // Overrides if assignment is Closed OR deadline passed with no late submissions allowed
      if (task.status === 'Closed') {
        // CLOSED by mentor
        if (sub) {
          // Student has submitted — let them view it
          statusBadgeHtml = `<span class="card-badge status-closed" style="background: rgba(239, 68, 68, 0.12); color: var(--color-danger); border: 1px solid rgba(239, 68, 68, 0.2);">Closed</span>`;
          actionBtnText = 'View Submission';
          actionBtnClass = 'btn-secondary';
          isReviewed = false; // Keep button enabled for view
          // But if already reviewed, show that status badge still
          if (sub.status === 'Reviewed') {
            statusBadgeHtml = `<span class="card-badge status-reviewed">Closed · Reviewed (${sub.marks}%)</span>`;
          }
        } else {
          // No submission — just show closed, no button
          statusBadgeHtml = `<span class="card-badge status-closed" style="background: rgba(239, 68, 68, 0.12); color: var(--color-danger); border: 1px solid rgba(239, 68, 68, 0.2);">Assignment Closed</span>`;
          actionBtnText = 'Assignment Closed';
          actionBtnClass = 'btn-secondary';
          isReviewed = true; // Disable button
        }
      } else if (isDeadlinePassed && !isLateAllowed) {
        // Deadline passed, no late allowed
        isReviewed = true;
        actionBtnText = 'Locked (Deadline Passed)';
        actionBtnClass = 'btn-secondary';
        if (!sub) {
          statusBadgeHtml = `<span class="card-badge status-closed" style="background: rgba(239, 68, 68, 0.12); color: var(--color-danger); border: 1px solid rgba(239, 68, 68, 0.2);">Deadline Passed</span>`;
        } else if (sub.status === 'Resubmission Requested') {
          statusBadgeHtml = `<span class="card-badge status-closed" style="background: rgba(239, 68, 68, 0.12); color: var(--color-danger); border: 1px solid rgba(239, 68, 68, 0.2);">Closed (Expired)</span>`;
        }
      } else if (isDeadlinePassed && isLateAllowed && !isReviewed) {
        // Overdue but late submission is allowed
        if (!sub) {
          statusBadgeHtml = `<span class="card-badge status-submitted" style="background: rgba(251, 191, 36, 0.12); color: var(--color-warning); border: 1px solid rgba(251, 191, 36, 0.2); text-transform: uppercase;">Overdue (Late Allowed)</span>`;
          actionBtnText = 'Submit Late';
          actionBtnClass = 'btn-warning';
        } else if (sub.status === 'Submitted') {
          statusBadgeHtml = `<span class="card-badge status-submitted" style="background: rgba(251, 191, 36, 0.12); color: var(--color-warning); border: 1px solid rgba(251, 191, 36, 0.2); text-transform: uppercase;">Awaiting Review (Late)</span>`;
          actionBtnText = 'Update Late Submission';
          actionBtnClass = 'btn-secondary';
        } else if (sub.status === 'Resubmission Requested') {
          statusBadgeHtml = `<span class="card-badge status-closed" style="background: rgba(239, 68, 68, 0.15); color: var(--color-danger); border: 1px solid rgba(239, 68, 68, 0.25);">Resubmission Required (Late)</span>`;
          actionBtnText = 'Submit Fixes (Late)';
          actionBtnClass = 'btn-success';
        }
      }

      // Drive link action
      let downloadLinkHtml = '';
      if (task.drive_file_url) {
        downloadLinkHtml = `
          <a href="${task.drive_file_url}" target="_blank" class="btn btn-secondary" style="font-size: 0.8rem; padding: 0.4rem 0.8rem; flex: 1;" tabindex="-1">
            <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24" style="margin-right: 0.3rem;"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/></svg>
            Resource File
          </a>
        `;
      }

      const formattedDeadline = new Date(task.deadline).toLocaleString();

      // Build instructions HTML (only students see this)
      let instructionsHtml = '';
      if (task.instructions) {
        const formattedInstructions = task.instructions.replace(/\n/g, '<br>');
        instructionsHtml = `
          <details style="margin-top: 0.5rem; background: rgba(83, 155, 245, 0.05); border: 1px solid rgba(83, 155, 245, 0.15); border-radius: 6px; padding: 0;">
            <summary style="cursor: pointer; font-size: 0.78rem; font-weight: 700; color: var(--color-primary); padding: 0.5rem 0.75rem; user-select: none; display: flex; align-items: center; gap: 0.4rem;">
              <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>
              View Instructions from Mentor
            </summary>
            <div style="padding: 0.5rem 0.75rem 0.75rem; font-size: 0.78rem; color: var(--text-secondary); line-height: 1.6; border-top: 1px solid rgba(83, 155, 245, 0.1);">
              ${formattedInstructions}
            </div>
          </details>
        `;
      }

      card.innerHTML = `
        <div class="card-header-badge-row">
          <span class="card-subtitle">${task.subject}</span>
          ${statusBadgeHtml}
        </div>
        <div class="card-title" id="card-title-${task.assignment_id}">${task.title}</div>
        <div class="card-desc">${task.description}</div>
        ${instructionsHtml}
        <div class="card-metadata">
          <span>Deadline: ${formattedDeadline}</span>
        </div>
        <div style="display: flex; gap: 0.75rem; margin-top: 0.5rem;">
          ${downloadLinkHtml}
          <button class="btn ${actionBtnClass}" 
            style="font-size: 0.8rem; padding: 0.4rem 0.8rem; flex: 1.2; ${isReviewed ? 'opacity: 0.55; cursor: not-allowed;' : ''}"
            ${isReviewed ? 'disabled' : `onclick="app.openSubmitPanel('${task.assignment_id}')"`}>
            ${actionBtnText}
          </button>
        </div>
      `;
      grid.appendChild(card);
    });
  },

  openSubmitPanel(assignmentId) {
    const studentId = state.currentRole;
    const sub = state.submissions.find(s => s.assignment_id === assignmentId && s.student_id === studentId);
    if (sub && sub.status === 'Reviewed') {
      this.showToast('This submission is locked and reviewed. Resubmission is not permitted.', 'warning');
      return;
    }

    const task = state.assignments.find(a => a.assignment_id === assignmentId);
    if (!task) return;

    const isDeadlinePassed = new Date() > new Date(task.deadline);
    const isLateAllowed = String(task.allow_late_submissions).toLowerCase() === 'true';

    // If closed with NO submission — block entirely
    if (task.status === 'Closed' && !sub) {
      this.showToast('This assignment has been closed by the mentor. Submissions are no longer accepted.', 'error');
      return;
    }

    // If deadline passed and late not allowed (and not closed-with-submission case)
    if (task.status !== 'Closed' && isDeadlinePassed && !isLateAllowed) {
      this.showToast('The deadline has passed and late submissions are not allowed.', 'warning');
      return;
    }

    const isViewOnly = task.status === 'Closed' && !!sub;

    this.showView('student-submit-pane');
    
    document.getElementById('submit-panel-title').textContent = isViewOnly
      ? `Submission Details: ${task.title}`
      : `Submit Code: ${task.title}`;
    document.getElementById('submit-assignment-id-ref').value = task.assignment_id;
    
    // Prepopulate form fields
    if (sub) {
      document.getElementById('submit-repo').value = sub.repo_link || '';
      document.getElementById('submit-commit').value = sub.commit_hash || '';
      document.getElementById('submit-commit-url').value = sub.commit_url || '';
    } else {
      document.getElementById('student-submission-form').reset();
    }

    // Lock form inputs and submit button in view-only mode
    const inputs = ['submit-repo', 'submit-commit', 'submit-commit-url'];
    const submitBtn = document.getElementById('submit-student-file-btn');
    if (isViewOnly) {
      inputs.forEach(id => { const el = document.getElementById(id); if (el) el.setAttribute('readonly', 'true'); });
      submitBtn.disabled = true;
      submitBtn.textContent = 'Assignment Closed — View Only';
      submitBtn.style.opacity = '0.55';
      submitBtn.style.cursor = 'not-allowed';
    } else {
      inputs.forEach(id => { const el = document.getElementById(id); if (el) el.removeAttribute('readonly'); });
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Code Version';
      submitBtn.style.opacity = '';
      submitBtn.style.cursor = '';
    }
  },

  // Action: Submit assignment (Student flow)
  async handleStudentSubmit() {
    const studentId = state.currentRole;
    const assignmentId = document.getElementById('submit-assignment-id-ref').value;
    const task = state.assignments.find(a => a.assignment_id === assignmentId);
    if (!task) return;

    const isDeadlinePassed = new Date() > new Date(task.deadline);
    const isLateAllowed = String(task.allow_late_submissions).toLowerCase() === 'true';

    if (task.status === 'Closed' || (isDeadlinePassed && !isLateAllowed)) {
      this.showToast('Submissions are locked for this assignment.', 'error');
      return;
    }

    const repo = document.getElementById('submit-repo').value;
    const commit = document.getElementById('submit-commit').value;
    const commitUrl = document.getElementById('submit-commit-url').value;
    
    const submitBtn = document.getElementById('submit-student-file-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting Commit Hash...';

    const payload = {
      action: 'submitAssignment',
      assignment_id: assignmentId,
      student_id: studentId,
      repo_link: repo,
      commit_hash: commit,
      commit_url: commitUrl
    };

    try {
      const response = await fetch(state.apiUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'text/plain' }
      });
      const json = await response.json();
      if (!json.success) throw new Error(json.error);
      
      this.showToast('Code version submitted successfully to Google Sheets database!', 'success');
      
      await this.syncData();
      this.showView('student-assignments');
      
    } catch (err) {
      this.showToast(`Submission failed: ${err.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Code Version';
    }
  },

  renderStudentPerformanceTable() {
    const studentId = state.currentRole;
    const tbody = document.getElementById('student-performance-table-body');
    tbody.innerHTML = '';
    
    const mySubmissions = state.submissions.filter(s => s.student_id === studentId);
    
    if (mySubmissions.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-tertiary);">You have not made any submissions yet. Once graded, feedback will appear here.</td></tr>`;
      return;
    }

    mySubmissions.forEach(sub => {
      const assignment = state.assignments.find(a => a.assignment_id === sub.assignment_id);
      const row = document.createElement('tr');
      
      let statusClass = 'status-submitted';
      if (sub.status === 'Reviewed') statusClass = 'status-reviewed';
      if (sub.status === 'Resubmission Requested') statusClass = 'status-closed';

      row.innerHTML = `
        <td style="font-weight: 600;">${assignment ? assignment.title : sub.assignment_id}</td>
        <td>${new Date(sub.submitted_time).toLocaleString()}</td>
        <td style="font-weight: 700;">${sub.marks !== "" ? sub.marks + "/100" : "-"}</td>
        <td><span class="card-badge ${statusClass}">${sub.status}</span></td>
        <td style="font-size: 0.85rem; color: var(--text-secondary); max-width: 400px; line-height: 1.45;">
          ${sub.feedback ? sub.feedback : `<span style="color: var(--text-tertiary); font-style:italic;">Awaiting review comments from mentor...</span>`}
        </td>
      `;
      tbody.appendChild(row);
    });
  },

  // ---------------------------------------------------------
  // FLOATING ALERTS (TOAST NOTIFICATIONS)
  // ---------------------------------------------------------
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-hub');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    // Simple icon indicators
    let iconSvg = '';
    if (type === 'success') {
      iconSvg = `<svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`;
    } else if (type === 'error') {
      iconSvg = `<svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`;
    } else {
      iconSvg = `<svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 11h-2V7h2v6zm0 4h-2v-2h2v2z"/></svg>`;
    }

    toast.innerHTML = `
      ${iconSvg}
      <span class="toast-message">${message}</span>
    `;
    
    container.appendChild(toast);
    
    // Auto-remove toast after 4s
    setTimeout(() => {
      toast.style.animation = 'fadeIn 0.3s reverse forwards';
      setTimeout(() => {
        toast.remove();
      }, 300);
    }, 4000);
  },

  // Resource Sharing Mentor Handler
  async handleShareResource() {
    const title = document.getElementById('res-title').value;
    const type = document.getElementById('res-type').value;
    const fileUrlRaw = document.getElementById('res-drive-url').value;
    
    const fileInput = document.getElementById('res-file-input');
    const submitBtn = document.getElementById('submit-resource-btn');
    
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sharing Resource...';
    
    let base64Data = null;
    let fileName = null;
    
    if (fileInput && fileInput.files.length > 0) {
      const file = fileInput.files[0];
      fileName = file.name;
      base64Data = await this.readFileAsBase64(file);
    }

    const payload = {
      action: 'shareResource',
      title,
      type,
      drive_file_url: fileUrlRaw,
      drive_file_name: fileName || '',
      fileData: base64Data,
      fileName: fileName,
      shared_by: 'Mentor'
    };

    try {
      const response = await fetch(state.apiUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'text/plain' }
      });
      const json = await response.json();
      if (!json.success) throw new Error(json.error);
      
      this.showToast('Successfully shared resource to Drive and Sheets Database!', 'success');
      
      // Reset Form
      document.getElementById('share-resource-form').reset();
      if (document.getElementById('res-uploaded-filename')) {
        document.getElementById('res-uploaded-filename').textContent = 'No file selected';
      }
      if (document.getElementById('res-upload-status-text')) {
        document.getElementById('res-upload-status-text').textContent = 'Click or drag a file to upload directly to Drive folder';
      }
      
      await this.syncData();
      this.renderMentorResources();
      
    } catch (err) {
      console.error(err);
      this.showToast(`Sharing failed: ${err.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Share Resource';
    }
  },

  async handleDeleteResource(resourceId) {
    const res = state.resources.find(r => r.resource_id === resourceId);
    if (!res) return;

    try {
      const payload = {
        action: 'deleteResource',
        resource_id: resourceId
      };
      const response = await fetch(state.apiUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'text/plain' }
      });
      const json = await response.json();
      if (!json.success) throw new Error(json.error);
      this.showToast('Resource deleted from Google Sheets!', 'success');

      await this.syncData();
      this.renderMentorResources();

    } catch (err) {
      this.showToast(`Deletion failed: ${err.message}`, 'error');
    }
  },

  renderMentorResources() {
    const tbody = document.getElementById('mentor-resources-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (state.resources.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-tertiary); padding: 2rem;">No resources shared yet. Share a document/link above to get started.</td></tr>`;
      return;
    }

    const sortedResources = [...state.resources].sort((a, b) => new Date(b.created_date) - new Date(a.created_date));

    sortedResources.forEach(res => {
      const row = document.createElement('tr');
      
      const typeBadges = {
        video: { bg: 'rgba(83,155,245,0.12)', color: 'var(--color-primary)' },
        pdf: { bg: 'rgba(229,83,75,0.12)', color: 'var(--color-danger)' },
        photo: { bg: 'rgba(251,191,36,0.12)', color: 'var(--color-warning)' },
        link: { bg: 'rgba(168,85,247,0.12)', color: '#a855f7' },
        document: { bg: 'rgba(87,171,90,0.12)', color: 'var(--color-success)' }
      };
      
      const badgeStyle = typeBadges[res.type.toLowerCase()] || { bg: 'rgba(255,255,255,0.1)', color: '#ffffff' };
      const typeBadge = `<span style="font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 0.2rem 0.55rem; border-radius: 999px; background: ${badgeStyle.bg}; color: ${badgeStyle.color}; border: 1px solid ${badgeStyle.color}33;">${res.type}</span>`;

      row.innerHTML = `
        <td style="font-weight: 600; color: #ffffff;">${res.title}</td>
        <td>${typeBadge}</td>
        <td><a href="${res.url}" target="_blank" style="color: var(--color-primary); font-size: 0.85rem;">View Resource →</a></td>
        <td>${new Date(res.created_date).toLocaleString()}</td>
        <td>
          <button class="btn btn-danger" style="padding: 0.3rem 0.6rem; font-size: 0.75rem; background-color: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2); color: var(--color-danger);" onclick="if(confirm('Are you sure you want to delete this resource?')){ app.handleDeleteResource('${res.resource_id}') }">Delete</button>
        </td>
      `;
      tbody.appendChild(row);
    });
  },

  renderStudentResources() {
    const grid = document.getElementById('student-resources-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const activeTab = document.querySelector('.resource-filter-btn.active');
    const selectedType = activeTab ? activeTab.getAttribute('data-type') : 'All';
    const searchInputEl = document.getElementById('student-resources-search');
    const searchQuery = searchInputEl ? searchInputEl.value.toLowerCase().trim() : '';

    let filtered = [...state.resources];

    if (selectedType !== 'All') {
      filtered = filtered.filter(res => res.type.toLowerCase() === selectedType.toLowerCase());
    }

    if (searchQuery) {
      filtered = filtered.filter(res => res.title.toLowerCase().includes(searchQuery));
    }

    if (filtered.length === 0) {
      grid.innerHTML = `<div style="grid-column: span 3; text-align: center; padding: 3rem; color: var(--text-tertiary);">No resources match the selected criteria.</div>`;
      return;
    }

    filtered.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));

    const icons = {
      video: `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4zM14 16H5V8h9v8z"/></svg>`,
      pdf: `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z"/></svg>`,
      photo: `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`,
      link: `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>`,
      document: `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`
    };

    const typeBadges = {
      video: { bg: 'rgba(83,155,245,0.12)', color: 'var(--color-primary)' },
      pdf: { bg: 'rgba(229,83,75,0.12)', color: 'var(--color-danger)' },
      photo: { bg: 'rgba(251,191,36,0.12)', color: 'var(--color-warning)' },
      link: { bg: 'rgba(168,85,247,0.12)', color: '#a855f7' },
      document: { bg: 'rgba(87,171,90,0.12)', color: 'var(--color-success)' }
    };

      filtered.forEach(res => {
        const card = document.createElement('div');
        card.className = 'content-card';
        
        const badgeStyle = typeBadges[res.type.toLowerCase()] || { bg: 'rgba(255,255,255,0.1)', color: '#ffffff' };
        const iconHtml = icons[res.type.toLowerCase()] || icons.document;

        card.innerHTML = `
          <div class="card-header-badge-row">
            <div class="stat-icon" style="color: ${badgeStyle.color}; background: ${badgeStyle.bg}; width: 36px; height: 36px; border-radius: 8px;">
              ${iconHtml}
            </div>
            <span class="card-badge" style="background: ${badgeStyle.bg}; color: ${badgeStyle.color}; border: 1px solid ${badgeStyle.color}33;">${res.type}</span>
          </div>
          <div class="card-title" style="margin-top: 0.5rem; font-size: 1rem; line-height: 1.4; height: 44px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
            ${res.title}
          </div>
          <div class="card-metadata" style="margin-top: auto; border-top: 1px solid var(--border-color); padding-top: 0.75rem; font-size: 0.72rem;">
            <span>Shared: ${new Date(res.created_date).toLocaleDateString()}</span>
            <span>By: ${res.shared_by}</span>
          </div>
          <div style="margin-top: 0.5rem;">
            <a href="${res.url}" target="_blank" class="btn btn-primary" style="width: 100%; font-size: 0.8rem; padding: 0.45rem 0.8rem;">
              Open Resource →
            </a>
          </div>
        `;
        grid.appendChild(card);
      });
  },

  renderStudentGradesChart(studentId) {
    const canvas = document.getElementById('student-grades-chart');
    if (!canvas) return;
    if (typeof Chart === 'undefined') {
      console.warn('Chart.js library is not loaded. Cannot draw grades graph.');
      return;
    }

    // Filter student submissions
    const myReviewed = state.submissions.filter(s => s.student_id === studentId && s.status === 'Reviewed' && s.marks !== "");
    
    // Sort reviewed submissions by date submitted or assignment deadline to make it chronological
    const sortedReviewed = myReviewed.sort((a, b) => {
      const taskA = state.assignments.find(t => t.assignment_id === a.assignment_id);
      const taskB = state.assignments.find(t => t.assignment_id === b.assignment_id);
      const dateA = taskA ? new Date(taskA.deadline) : new Date(a.submitted_time);
      const dateB = taskB ? new Date(taskB.deadline) : new Date(b.submitted_time);
      return dateA - dateB;
    });

    const labels = [];
    const dataPoints = [];

    sortedReviewed.forEach(sub => {
      const task = state.assignments.find(t => t.assignment_id === sub.assignment_id);
      const title = task ? (task.title.length > 15 ? task.title.substring(0, 15) + '...' : task.title) : sub.assignment_id;
      labels.push(title);
      dataPoints.push(Number(sub.marks));
    });

    // Destroy existing chart if it exists
    if (this.gradesChartInstance) {
      this.gradesChartInstance.destroy();
    }

    if (labels.length === 0) {
      // Draw empty placeholder text on canvas
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#64748b'; // var(--text-tertiary) fallback
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No assignments reviewed yet to chart.', canvas.width / 2, canvas.height / 2);
      return;
    }

    // Initialize Chart.js
    const ctx = canvas.getContext('2d');
    this.gradesChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Grade (%)',
          data: dataPoints,
          backgroundColor: 'rgba(83, 155, 245, 0.45)',
          borderColor: 'var(--color-primary)',
          borderWidth: 1.5,
          borderRadius: 4,
          hoverBackgroundColor: 'rgba(83, 155, 245, 0.75)'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function(context) {
                return `Score: ${context.parsed.y}%`;
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#94a3b8', font: { size: 10 } }
          },
          x: {
            grid: { display: false },
            ticks: { color: '#94a3b8', font: { size: 10 } }
          }
        }
      }
    });
  },

  renderMentorStudents() {
    const tbody = document.getElementById('mentor-students-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const searchInput = document.getElementById('mentor-students-search');
    const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';

    let filtered = [...state.students];
    if (searchQuery) {
      filtered = filtered.filter(s => 
        s.name.toLowerCase().includes(searchQuery) || 
        s.student_id.toLowerCase().includes(searchQuery) ||
        s.email.toLowerCase().includes(searchQuery)
      );
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-tertiary); padding: 2rem;">No students found.</td></tr>`;
      return;
    }

    filtered.forEach(s => {
      const statusText = s.status || 'Active';
      const isActive = statusText === 'Active';
      
      const badgeStyle = isActive 
        ? { bg: 'rgba(87,171,90,0.12)', color: 'var(--color-success)' }
        : { bg: 'rgba(239,68,68,0.12)', color: 'var(--color-danger)' };

      const statusBadge = `<span style="font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 0.2rem 0.55rem; border-radius: 999px; background: ${badgeStyle.bg}; color: ${badgeStyle.color}; border: 1px solid ${badgeStyle.color}33;">${statusText}</span>`;
      
      const actionButton = isActive
        ? `<button class="btn btn-danger" style="padding: 0.3rem 0.6rem; font-size: 0.75rem; background-color: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2); color: var(--color-danger);" onclick="if(confirm('Are you sure you want to suspend account for ${s.name}?')){ app.toggleStudentStatus('${s.student_id}', 'Suspended') }">Suspend</button>`
        : `<button class="btn btn-success" style="padding: 0.3rem 0.6rem; font-size: 0.75rem; background-color: rgba(34, 197, 94, 0.1); border-color: rgba(34, 197, 94, 0.2); color: var(--color-success);" onclick="app.toggleStudentStatus('${s.student_id}', 'Active')">Unsuspend</button>`;

      const row = document.createElement('tr');
      row.innerHTML = `
        <td style="font-weight: 600; color: #ffffff;">${s.student_id}</td>
        <td style="font-weight: 600; color: #ffffff;">${s.name}</td>
        <td>${s.email}</td>
        <td><a href="https://github.com/${s.github_username}" target="_blank" style="color: var(--color-primary); font-size: 0.85rem;">${s.github_username}</a></td>
        <td>${statusBadge}</td>
        <td>${actionButton}</td>
      `;
      tbody.appendChild(row);
    });
  },

  async toggleStudentStatus(studentId, newStatus) {
    const student = state.students.find(s => s.student_id === studentId);
    if (!student) return;

    try {
      const payload = {
        action: 'toggleStudentStatus',
        student_id: studentId,
        status: newStatus
      };
      const response = await fetch(state.apiUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'text/plain' }
      });
      const json = await response.json();
      if (!json.success) throw new Error(json.error);
      this.showToast(`Account status updated to ${newStatus} for ${student.name}`, 'success');

      await this.syncData();
      this.renderMentorStudents();

      // If the currently logged-in student is suspended, log them out if active
      if (newStatus === 'Suspended' && state.currentRole === studentId) {
        this.handleSuspensionLogout();
      }

    } catch (err) {
      this.showToast(`Failed to update account status: ${err.message}`, 'error');
    }
  },

  showLoginScreen(show) {
    const loginContainer = document.getElementById('login-container');
    const appContainer = document.getElementById('app-container');
    if (show) {
      loginContainer.style.display = 'flex';
      appContainer.style.display = 'none';
      state.isAuthenticated = false;
    } else {
      loginContainer.style.display = 'none';
      appContainer.style.display = 'flex';
    }
  },

  updateProfileUI(name, role, initials = 'M') {
    document.getElementById('sidebar-user-name').textContent = name;
    document.getElementById('sidebar-user-role').textContent = role;
    document.getElementById('sidebar-user-avatar').textContent = initials;
  },

  async handleLogin() {
    const emailInput = document.getElementById('login-email').value.trim().toLowerCase();
    const passwordInput = document.getElementById('login-password').value;
    
    // 1. Try to find a matching mentor account
    const mentor = state.mentors.find(m => 
      (m.email && m.email.toLowerCase() === emailInput) || 
      (m.mentor_id && m.mentor_id.toLowerCase() === emailInput) ||
      (m.username && m.username.toLowerCase() === emailInput)
    );
    
    // Check fallback default mentor credentials
    const isDefaultMentor = (emailInput === 'mentor@suretrust.org' || emailInput === 'mentor');
    
    // 2. Try to find a matching student account
    const student = state.students.find(s => 
      (s.email && s.email.toLowerCase() === emailInput) || 
      (s.student_id && s.student_id.toLowerCase() === emailInput) ||
      (s.username && s.username.toLowerCase() === emailInput)
    );

    // 3. Process Mentor Login
    if (mentor || isDefaultMentor) {
      const correctPassword = mentor ? (mentor.password || 'mentor123') : 'mentor123';
      if (passwordInput === correctPassword) {
        const mentorStatus = mentor ? (mentor.status || 'Active') : 'Active';
        if (mentorStatus === 'Suspended') {
          this.showToast('Login failed: Your account has been suspended. Please contact the administrator.', 'error');
          alert('Your account has been suspended. Please contact the administrator.');
          return;
        }
        state.isAuthenticated = true;
        state.currentRole = 'mentor';
        localStorage.setItem('ag_lms_session', 'mentor');
        this.updateProfileUI(mentor ? (mentor.name || 'Mentor') : 'Mentor Admin', 'Instructor');
        this.switchRole('mentor');
        this.showLoginScreen(false);
        document.getElementById('login-form').reset();
        this.showToast(`Logged in as ${mentor ? (mentor.name || 'Mentor') : 'Mentor Admin'}`, 'success');
        return;
      } else {
        this.showToast('Login failed: Password was incorrect. Please try again.', 'error');
        return;
      }
    }
    
    // 4. Process Student Login
    if (student) {
      const correctPassword = student.password || 'student123';
      const isPasswordValid = (passwordInput === correctPassword || passwordInput.toLowerCase() === student.student_id.toLowerCase());
      
      if (isPasswordValid) {
        if (student.status === 'Suspended') {
          this.showToast('Login failed: Your account has been suspended. Please contact the administrator.', 'error');
          alert('Your account has been suspended. Please contact the administrator.');
          return;
        }
        
        state.isAuthenticated = true;
        state.currentRole = student.student_id;
        localStorage.setItem('ag_lms_session', student.student_id);
        
        const initials = student.name.substring(0, 2);
        this.updateProfileUI(student.name, 'Learner', initials);
        this.switchRole(student.student_id);
        this.showLoginScreen(false);
        document.getElementById('login-form').reset();
        this.showToast(`Welcome back, ${student.name}!`, 'success');
        return;
      } else {
        this.showToast('Login failed: Password was incorrect. Please try again.', 'error');
        return;
      }
    }
    
    // 5. Account not found at all
    this.showToast('Login failed: User account not found.', 'error');
  },

  handleLogout() {
    localStorage.removeItem('ag_lms_session');
    state.isAuthenticated = false;
    state.currentRole = 'mentor'; // default
    this.showLoginScreen(true);
    this.showToast('Logged out successfully.', 'info');
  },

  handleSuspensionLogout() {
    localStorage.removeItem('ag_lms_session');
    state.isAuthenticated = false;
    state.currentRole = 'mentor';
    this.showLoginScreen(true);
    alert('Your account has been suspended. Please contact the administrator.');
    this.showToast('Your account has been suspended. Please contact the administrator.', 'error');
  }
};

// Start system on page load
window.addEventListener('DOMContentLoaded', async () => {
  try {
    await app.init();
  } catch (startupError) {
    console.error('LMS Startup Error:', startupError);
    // Show login screen and let user retry
    const login = document.getElementById('login-container');
    const appContainer = document.getElementById('app-container');
    if (login) login.style.display = 'flex';
    if (appContainer) appContainer.style.display = 'none';
    alert('Could not connect to Google Sheets: ' + startupError.message + '\nPlease check your internet connection and refresh the page.');
  }
});
