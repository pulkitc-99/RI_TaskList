// 📦 Extract session & user details
const session = $('Updated Session').first().json.state
const currRole = $('Get User Details').first().json.role
const currInput = $('Trigger upon receiving telegram message').first().json.message.text
const currUserID = $('Trigger upon receiving telegram message').first().json.message.from.id
const currUserName = $('Get User Details').first().json.first_name

// Extract current state from the state stack
let currState = peekState(stateStack)

// 🌸 Start of the divine switch
// If a new session has started, greet the user
// Next State: session_started
if (currState === 'new_session') {
  return [
    {
      json: {
        route: 'postgresNode',
        info: 'change state from new_session to session_started',
        query: `UPDATE track_session SET state = '{'session_started'}', workflow_process = false, last_updated = NOW() WHERE user_id = '${currUserID}';`,
      },
      json: { route: 'greet' },
    },
  ]
}

// ──────────────────────────────
// 🌺 STACK HELPERS
// ──────────────────────────────

function pushState(stack, newState) {
  return [...stack, newState]
}

function popState(stack) {
  return stack.length > 1 ? stack.slice(0, -1) : stack
}

function peekState(stack) {
  return stack[stack.length - 1]
}

function replaceTopState(stack, newTop) {
  return [...stack.slice(0, -1), newTop]
}

// ──────────────────────────────
// 🌿 MENU MAPPING
// ──────────────────────────────

function getNextStateFromInput(input) {
  /** @type {{ [key: string]: string }} */
  const mapping = {
    '➕ Add Task': 'adding_new_task_started',
    '🔍 View Tasks': 'view_tasks_started',
    '✏️Update Task': 'update_task_started',
    '📤 Send Tasks': 'send_tasks_started',
    '📊 Generate Report': 'generate_report_started',
    '🗂️ Backup': 'backup_started',
    '⚙️ Other': 'other_started',
    '🔍 View My Tasks': 'view_my_tasks_started',
    '✏️Update Task Assignment Status': 'update_assignment_status_started',
  }

  return mapping[String(input)] || 'invalid'
}
