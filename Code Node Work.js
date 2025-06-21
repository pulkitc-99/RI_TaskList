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
    const nextState = getNextStateFromInput(currInput, currRole)

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

          query: `UPDATE track_session
SET context_data = jsonb_build_object(
  'clients',
  (
    SELECT json_agg(json_build_object('uid', uid, 'name', name))
    FROM clients
  )
),
last_updated = NOW()
WHERE user_id = '${currUserID}';`.trim(),
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
    const context = $('Updated Session').first().json.context_data || {}
    const clientList = Array.isArray(context.clients) ? context.clients : []

    const clientText = clientList.map((client) => `🔹 ${client.name} (${client.uid})`).join('\n')

    const message =
      `${currUserName},` +
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

  // 🌸 Flow: Add a new Task
  // Once the user has entered a particular client, we check their validity and proceed accordingly.
  // Next state: add_task_receivedTaskDetails
  if (currState === 'add_task_selectedClient') {
    const context = $('Updated Session').first().json.context_data || {}
    const clientList = Array.isArray(context.clients) ? context.clients : []

    const clientInput = String(currInput).trim()

    const foundClient = clientList.find(
      (client) =>
        client.uid.toLowerCase() === clientInput.toLowerCase() ||
        client.name.toLowerCase() === clientInput.toLowerCase()
    )

    // If the client is not found or valid, go back to the previous state and try again
    if (!foundClient) {
      const revertStateStack = replaceTopState(session, 'add_task_retrievedClients')
      return [
        {
          json: {
            route: 'postgresNode',
            info: 'Updating state back to add_task_retrievedClients due to invalid Client',
            query: `
          UPDATE track_session 
          SET state = '${JSON.stringify(revertStateStack)}'::jsonb,
              workflow_process = true,
              last_updated = NOW()
          WHERE user_id = '${currUserID}';
        `.trim(),
          },
        },
        {
          json: {
            route: 'telegramNode',
            info: 'Client not found — prompting user to try again',
            message: `⚠️ Hmm, I couldn't find a client by that name or UID. Please try again or type /New to create a new client.`,
          },
        },
      ]
    }
    const newStateStack = replaceTopState(session, 'add_task_receivedTaskDetails')

    // Prepare Message to send to user - asking to enter task details with an example
    const taskMessage = `📝 Wonderful! Please share the task details in simple *Key:Value* format, like this:

*title*: Follow up with vendor
*due*: 22-06-2025
*priority*: High
*status*: Not Started

🌼 Only *title* is required — the rest are optional and can be edited anytime.

Take your time. I'm right here when you're ready ✨`

    // Store the client's name and UID in context_data
    return [
      {
        json: {
          route: 'postgresNode',
          info: `Storing selected client UID (${foundClient.uid}) in context_data`,
          query: `UPDATE track_session
          SET context_data = jsonb_set(
            context_data,
            '{selected_client}', to_jsonb(json_build_object('uid', '${foundClient.uid}','name', '${foundClient.name}'))
          ),
          state = '${JSON.stringify(newStateStack)}'::jsonb,
          workflow_process = false,
          last_updated = NOW()
          WHERE user_id = '${currUserID}';`.trim(),
        },
      },

      // Ask the user to enter details of the task
      {
        json: {
          route: 'telegramNode',
          info: 'Asking user for task details',
          message: taskMessage,
        },
      },
    ]
  }

  // 🌸 Flow: Add a new Task
  // Once the user has entered the new task's details, we parse and validate them, and proceed accordingly.
  // Next state: add_task_confirmedTaskDetails
  if (currState === 'add_task_receivedTaskDetails') {
    const taskText = String(currInput).trim()
    const context = $('Updated Session').first().json.context_data || {}
    const selectedClient = context.selected_client || {}

    // 🌿 Parse key:value input using helper function
    const parsedResult = parseTaskDetails(taskText)

    // If the input is not correct, then inform the user and try again.
    if (!parsedResult.success) {
      const revertStateStack = replaceTopState(session, 'add_task_selectedClient')
      return [
        {
          json: {
            route: 'postgresNode',
            info: parsedResult.info,
            query: `
          UPDATE track_session 
          SET state = '${JSON.stringify(revertStateStack)}'::jsonb,
              workflow_process = true,
              last_updated = NOW()
          WHERE user_id = '${currUserID}';
        `.trim(),
          },
        },
        {
          json: {
            route: 'telegramNode',
            message: parsedResult.message,
          },
        },
      ]
    }

    // Test the parsed result for further validation
    const taskData = parsedResult.data
    const validation = validateTaskDetails(taskData)

    if (!validation.valid) {
      const revertStateStack = replaceTopState(session, 'add_task_selectedClient')

      return [
        {
          json: {
            route: 'postgresNode',
            info: validation.info,
            query: `
          UPDATE track_session 
          SET state = '${JSON.stringify(revertStateStack)}'::jsonb,
              workflow_process = true,
              last_updated = NOW()
          WHERE user_id = '${currUserID}';
        `.trim(),
          },
        },

        {
          json: {
            route: 'telegramNode',
            message: validation.message,
          },
        },
        // TODO Inform particular error thruogh helper function and try again.
      ]
    }

    const newStateStack = replaceTopState(session, 'add_task_verifiedTaskDetails')

    // Prepare message to send to user about confirming whether the task looks good.
    const formattedMessage = `🧑‍💼 ${selectedClient.name} [${selectedClient.uid}]

📝 ${taskData.title}

${taskData.due ? `📅 ${taskData.due}` : ''}
${taskData.priority || taskData.status ? `${taskData.priority ? `⚡ ${taskData.priority}` : ''}${taskData.status ? ` | ⏳ ${taskData.status}` : ''}` : ''}

👥 —

✅ If this looks good, reply *yes* to confirm.  
🚫 Or reply *no* to try again.`

    return [
      {
        json: {
          route: 'postgresNode',
          info: 'Saving parsed task details into context_data. Proceeding to add_task_verifiedDetails',
          query: `UPDATE track_session
        SET context_data = jsonb_set(
          context_data,
          '{task_details}', to_jsonb('${JSON.stringify(taskData)}'::json)
        ),
        state = '${JSON.stringify(newStateStack)}'::jsonb,
        workflow_process = false,
        last_updated = NOW()
        WHERE user_id = '${currUserID}';`.trim(),
        },
      },
      {
        json: {
          route: 'telegramNode',
          info: 'Confirming task details with user (yes/no) in formatted client card style',
          message: formattedMessage,
        },
      },
    ]
  }

  // 🌸 Flow: Add a new Task
  // Once the user's input of new task details are validated, we check the user's confirmation
  // and add the task into the database
  // Next state: adding_task_taskAdded
  // if (currState === 'add_task_verifiedTaskDetails') { }

  //TODO
  // 🌸 Flow: Add a new Task
  // Once the new task is added to the database, inform the user and ask if they want to assign this task
  // If YES: Next state stack: adding_task_assigningTaskAdded, assign_task
  // If NO:  Pop the state

  //TODO
  // 🌸 Flow: Add a new Task
  // This will come when the assign_task above this is popped. Simply pop it as adding task and assigning it is not complete
  // Next state: session_ongoing
  // if (currState === 'adding_task_assigningTaskAdded') { }

  //TODO
  // Since no more items are on top, ask if the user wants to do anything
  // If YES: Next state stack: session_ongoing, <the new action's state>
  // If NO:  Next state stack: session_ended
  // if (currState === 'session_ongoing') { }

  //TODO
  // This comes when the user triggers the workflow via telegram after the last session has ended
  // Simply start a new session
  // Next state: new_session
  // if (currState === 'session_ended') { }

  // 🌙 If no known state matched, return gracefully with no action
  return [
    {
      json: {
        info: 'No matching state found — doing nothing this flow.',
        route: 'noop',
      },
    },
  ]
}
// Return with no-op if workflow process flag is false
else
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

// function popState(stack) {
//   if (!Array.isArray(stack) || stack.length === 0) return []
//   return stack.length > 1 ? stack.slice(0, -1) : stack
// }

function peekState(stack) {
  if (!Array.isArray(stack) || stack.length === 0) return null
  return stack[stack.length - 1]
}

function replaceTopState(stack, newTop) {
  if (!Array.isArray(stack) || stack.length === 0) return [newTop]
  return [...stack.slice(0, -1), newTop]
}

// ──────────────────────────────
// 🌿 HELPER FUNCTIONS
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

// Parse the User's Input when they have entered details of a task
function parseTaskDetails(text) {
  // Split each line
  const lines = text.split('\n')

  const taskData = {}
  let foundColon = false

  // Convert each line into JS Object of key and value
  for (const line of lines) {
    if (line.includes(':')) {
      foundColon = true
      const [keyRaw, ...rest] = line.split(':')
      const key = keyRaw?.trim().toLowerCase()
      const value = rest.join(':').trim()
      if (key) taskData[key] = value
    }
  }

  // Return error if user didn't enter colon ':' sign in any line, violating key:value input request
  if (!foundColon) {
    return {
      success: false,
      info: 'Reverting back to add_task_selectedClient because of no colon',
      message: 'No colons found in input, please enter task details as Key:Value pairs',
    }
  }

  return { success: true, data: taskData }
}

// Validate the User's Input when they have entered task details
function validateTaskDetails(data) {
  if (!data.title) {
    return {
      valid: false,
      info: 'Reverting back to add_task_selectedClient because of missing task title',
      message: 'Every task needs a ✨ *title*. Please try again.',
    }
  }

  const allowedKeys = ['title', 'due', 'priority', 'status']
  const invalidKeys = Object.keys(data).filter((k) => !allowedKeys.includes(k))

  if (invalidKeys.length > 0) {
    return {
      valid: false,
      info: 'Reverting back to add_task_selectedClient because of incorrect keys entered',
      message: `Unknown field(s): *${invalidKeys.join(', ')}*.\nPlease use only: title, due, priority, status.`,
    }
  }

  if (data.due && !validateDueDate(data.due)) {
    return {
      valid: false,
      info: 'Reverting back to add_task_selectedClient because of incorrect date',
      message: `The 📅 *due date* "${data.due}" is not valid. Use *DD-MM-YY* format with a realistic date.`,
    }
  }

  return {
    valid: true,
  }
}

// Validate a date to be realistic and correctly formatted
function validateDueDate(dateStr) {
  // Return false if date is not in DD-MM-YY format
  const regex = /^(\d{2})-(\d{2})-(\d{2})$/
  const match = dateStr.match(regex)
  if (!match) return false

  // Check if date and month values are valid
  const [dd, mm, yy] = match.map(Number)
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return false

  // Check if date is realistic - not in the past and not in 100 years from present date
  const fullYear = 2000 + yy
  const dueDate = new Date(fullYear, mm - 1, dd)
  const now = new Date()
  const hundredYearsFromNow = new Date(now.getFullYear() + 100, 0, 1)

  return dueDate >= now && dueDate < hundredYearsFromNow
}
