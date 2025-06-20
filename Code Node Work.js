// 📦 Extract session & user details
const session = $('Updated Session').first().json.state
const workflow_process = $('Updated Session').first().json.workflow_process
const currRole = $('Get User Details').first().json.role
const currInput = $('Trigger upon receiving telegram message').first().json.message.text
const currUserID = $('Trigger upon receiving telegram message').first().json.message.from.id
const currUserName = $('Get User Details').first().json.first_name

// Extract current state from the state stack
let currState = peekState(session)

if (workflow_process == true) {
  // 🌸 Start of the divine switch and state based routing
  // 🌸 If a new session has started, greet the user
  // Next State: session_started
  if (currState === 'new_session') {
    return [
      {
        json: {
          route: 'postgresNode',
          info: 'change state from new_session to session_started',
          query: `
            UPDATE track_session 
            SET state = '["session_started"]'::jsonb,
                workflow_process = false,
                last_updated = NOW()
            WHERE user_id = '${currUserID}';
          `.trim(),
        },
      },
      {
        json: {
          route: 'greet',
        },
      },
    ]
  }

  // 🌼 If user has just started a session, ask them what they wish to do
  if (currState === 'session_started') {
    const nextState = getNextStateFromInput(currInput)

    if (nextState === 'invalid') {
      return [
        {
          json: {
            route: 'telegramNode',
            info: `Informing user of invalid command`,
            message: `Hmm... I couldnt understand what you want. Please choose from the options provided. Let's try again.`,
          },
        },
        {
          json: {
            route: 'greet',
          },
        },
      ]
    } else if (nextState === 'unauthorized') {
      return [
        {
          json: {
            route: 'telegramNode',
            info: `Informing user of they are not authorized`,
            message: `Hmm... it seems you are not authorized to do that. Please choose from the options provided. Let's try again.`,
          },
        },
        {
          json: {
            route: 'greet',
          },
        },
      ]
    } else {
      const newStateStack = pushState(session, nextState)
      return [
        {
          json: {
            route: 'postgresNode',
            info: `Updating state to push ${nextState} on the stack`,
            query: `
            UPDATE track_session 
            SET state = '${JSON.stringify(newStateStack)}'::jsonb,
                workflow_process = true,
                last_updated = NOW()
            WHERE user_id = '${currUserID}';
          `.trim(),
          },
        },
      ]
    }
  }

  // 🌸 Flow: Add a new Task
  // If it has just started, retrieve the list of clients
  // Next state: add_task_retrievedClients
  if (currState === 'add_task_started') {
    const newStateStack = replaceTopState(session, 'add_task_retrievedClients')

    return [
      {
        json: {
          route: 'postgresNode',
          info: 'Fetch all clients for this session',
          query: `UPDATE track_session SET context_data = 
          (SELECT json_agg(json_build_object('uid', uid, 'name', name)) 
          FROM clients) WHERE user_id = '${currUserID}';`.trim(),
        },
      },
      {
        json: {
          route: 'postgresNode',
          info: 'Updating state from add_task_started to add_task_retrievedClients',
          query: `
          UPDATE track_session 
          SET state = '${JSON.stringify(newStateStack)}'::jsonb,
              workflow_process = true,
              last_updated = NOW()
          WHERE user_id = '${currUserID}';
        `.trim(),
        },
      },
    ]
  }

  // 🌸 Flow: Add a new Task
  // If client list has been fetched, prepare list and ask user to select
  // Next state: add_task_selectedClient
  if (currState === 'add_task_retrievedClients') {
    const newStateStack = replaceTopState(session, 'add_task_selectedClient')

    // 🌼 Extract client list from context_data
    const context = $('Updated Session').first().json.context_data
    const clientList = Array.isArray(context) ? context : []

    // 🌷 Prepare a nicely formatted list of clients
    const clientText = clientList.map((client) => `🔹 ${client.name} (${client.uid})`).join('\n')

    const message =
      `🌼 Please choose a client for this task:\n\n${clientText}\n\n👉` +
      `Reply with the exact *UID* or *client name*.\n🌱 Or type /New to create a new client.`

    return [
      {
        json: {
          route: 'postgresNode',
          info: 'Updating state from add_task_retrievedClients to add_task_selectedClient',
          query: `
          UPDATE track_session 
          SET state = '${JSON.stringify(newStateStack)}'::jsonb,
              workflow_process = false,
              last_updated = NOW()
          WHERE user_id = '${currUserID}';
        `.trim(),
        },
      },
      {
        json: {
          route: 'telegramNode',
          info: 'Sending list of clients to user and asking for selection',
          message,
        },
      },
    ]
  }

  // 🌙 If no known state matched, return gracefully with no action
  return [
    {
      json: {
        info: 'No matching state found — doing nothing this flow.',
        route: 'noop',
      },
    },
  ]
} else
  return [
    {
      json: {
        info: 'Workflow is not to be processed',
        route: 'noop',
      },
    },
  ]

// ──────────────────────────────
// 🌺 STACK HELPERS
// ──────────────────────────────

function pushState(stack, newState) {
  const newStack = [...stack]
  const currentTop = newStack[newStack.length - 1]

  // 🌸 Avoid pushing duplicate states
  if (currentTop !== newState) {
    newStack.push(newState)
  }

  return newStack
}

function popState(stack) {
  if (!Array.isArray(stack) || stack.length === 0) return []
  return stack.length > 1 ? stack.slice(0, -1) : stack
}

function peekState(stack) {
  if (!Array.isArray(stack) || stack.length === 0) return null
  return stack[stack.length - 1]
}

function replaceTopState(stack, newTop) {
  if (!Array.isArray(stack) || stack.length === 0) return [newTop]
  return [...stack.slice(0, -1), newTop]
}

// ──────────────────────────────
// 🌿 MENU MAPPING
// ──────────────────────────────

// Get the next state based on the command that user has entered
function getNextStateFromInput(input, currRole) {
  /** @type {{ [key: string]: string }} */
  const mapping = {
    '➕ Add Task': 'add_task_started',
    '🔍 View Tasks': 'view_tasks_started',
    '✏️Update Task': 'update_task_started',
    '📤 Send Tasks': 'send_tasks_started',
    '📊 Generate Report': 'generate_report_started',
    '🗂️ Backup': 'backup_started',
    '⚙️ Other': 'other_started',
    '🔍 View My Tasks': 'view_my_tasks_started',
    '✏️Update Task Assignment Status': 'update_assignment_status_started',
  }

  const key = String(input)
  const nextState = mapping[key]

  // 🛡️ Role-based access check
  if (
    currRole === 'employee' &&
    nextState !== 'view_my_tasks_started' &&
    nextState !== 'update_assignment_status_started'
  ) {
    return 'unauthorized'
  }

  return nextState || 'invalid'
}
