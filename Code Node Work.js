// 📦 Extract session & user details
const session = $('Updated Session').first().json.state;
const currRole = $('Get User Details').first().json.role;
const currInput = $('Trigger upon receiving telegram message').first().json.message.text;
const currUserID = $('Trigger upon receiving telegram message').first().json.message.from.id;
const currUserName = $('Get User Details').first().json.first_name;

// Extract current state from the state stack
let currState = peekState(stateStack);


// 🌸 Start of the divine leela-switch
if (currState === 'new_session') {
  return [
    {
      json:
      {
      route: 'postgresNode',
      info: 'change state from new_session to session_started',
      query: `UPDATE track_session SET state = '{'session_started'}', workflow_process = false, last_updated = NOW() WHERE user_id = '${currUserID}';`
      },
      json: { route: 'greet' }
    }];
}

else if (currState === 'session_started') {
  const nextState = getNextStateFromInput(currInput);
  const updatedStack = pushState(stateStack, nextState);

  return [{
    json: {
      route: 'postgresNode',
      info: 'change of state',
      query: `UPDATE track_session SET state = '${JSON.stringify(updatedStack)}', workflow_processed = true, last_updated = NOW() WHERE user_id = '${currUserID}';`
    }
  }];
}

else if (currState === 'adding_new_task_started') {
  const updatedStack = replaceTopState(stateStack, 'adding_new_task_gotClientList');

  return [
    {
      json: {
        route: 'postgresNode',
        info: 'Set state to gotClientList',
        query: `UPDATE track_session SET state = '${JSON.stringify(updatedStack)}', workflow_processed = true, last_updated = NOW() WHERE user_id = '${currUserID}';`
      }
    },
    {
      json: {
        route: 'postgresNode',
        info: 'Update context_data with client list',
        query: `UPDATE track_session SET context_data = (SELECT json_agg(json_build_object('uid', uid, 'name', name)) FROM clients WHERE active = true) WHERE user_id = '${currUserID}';`
      }
    }
  ];
}

else if (currState === 'adding_new_task_gotClientList') {
  const updatedStack = replaceTopState(stateStack, 'adding_new_task_selectedClient');
  const clientList = session.context_data || [];

  const clientLines = clientList.map(c => `[${c.uid}] ${c.name}`).join('\n');
  const message = `🌸 ${currUserName}, please tell me which client this new task belongs to by entering their name or UID from the list below:\n\n${clientLines}`;

  return [
    {
      json: {
        route: 'postgresNode',
        info: 'advance to client selection',
        query: `UPDATE track_session SET state = '${JSON.stringify(updatedStack)}', workflow_processed = false, last_updated = NOW() WHERE user_id = '${currUserID}';`
      }
    },
    {
      json: {
        route: 'telegramNode',
        info: 'send client selection prompt',
        message: message
      }
    }
  ];
}

// 🌙 Default fallback
else {
  return [{}];
}


// ──────────────────────────────
// 🌺 STACK HELPERS
// ──────────────────────────────

function pushState(stack, newState) {
  return [...stack, newState];
}

function popState(stack) {
  return stack.length > 1 ? stack.slice(0, -1) : stack;
}

function peekState(stack) {
  return stack[stack.length - 1];
}

function replaceTopState(stack, newTop) {
  return [...stack.slice(0, -1), newTop];
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
    '✏️Update Task Assignment Status': 'update_assignment_status_started'
  };

  return mapping[String(input)] || 'invalid';
}
