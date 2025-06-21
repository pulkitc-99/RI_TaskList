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

  // State: new_session
  // 🌸 If a new session has started, greet the user and ask them what they wish to do
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

  // State: session_started
  // 🌼 Once the user has selected a command, parse
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
        endWorkflowUpdate(currUserID),
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
        endWorkflowUpdate(currUserID),
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
  // State: add_task_started
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
  // State: add_task_retrievedClients
  // If client list has been fetched, prepare list and ask user to select
  // Next state: add_task_selectedClient
  if (currState === 'add_task_retrievedClients') {
    const newStateStack = replaceTopState(session, 'add_task_selectedClient')

    // 🌼 Extract client list from context_data
    const context = $('Updated Session').first().json.context_data || {}
    const clientList = Array.isArray(context.clients) ? context.clients : []

    const clientText = clientList.map((client) => `🔹 ${client.name} (${client.uid})`).join('\n')

    // Prepare message to ask the user to choose a client from the list
    const message =
      `${currUserName},` +
      `🌼 Please choose a client for this task:\n\n${clientText}\n\n👉` +
      `Reply with the exact *UID* or *client name*.\n🌱 Or type /new to create a new client.`

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
  // State: add_task_selectedClient
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
            message: `⚠️ Hmm, I couldn't find a client by that name or UID. Please try again.\n`,
          },
        },
      ]
    }
    const newStateStack = replaceTopState(session, 'add_task_receivedTaskDetails')

    // Prepare Message to send to user - asking to enter task details with an example
    const taskMessage = `📝 Wonderful! Please share the task details in simple *Key:Value* format for ${foundClient.name}, like this:

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
  // State: add_task_receivedTaskDetails
  // Once the user has entered the new task's details, we parse and validate them, and proceed accordingly.
  // Next state: add_task_verifiedTaskDetails
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
  // State: add_task_verifiedTaskDetails
  // Once the user's input of new task details are validated, we check the user's confirmation
  // and then first retrieve all the current tasks' UIDs so that we can generate a unique one
  // Next state: add_task_retrievedTaskUIDs
  if (currState === 'add_task_verifiedTaskDetails') {
    const input = String(currInput).trim().toLowerCase()

    // If the user says "no" to the task details, then ask for it again
    if (input === 'no') {
      const revertStateStack = replaceTopState(session, 'add_task_selectedClient')
      return [
        {
          json: {
            route: 'postgresNode',
            info: 'User rejected task details — cleaning up and retrying. State becomes add_task_selectedClient',
            query: `
            UPDATE track_session
            SET context_data = context_data - 'task_details',
                state = '${JSON.stringify(revertStateStack)}'::jsonb,
                workflow_process = true,
                last_updated = NOW()
            WHERE user_id = '${currUserID}';
          `.trim(),
          },
        },
        {
          json: {
            route: 'telegramNode',
            message: '🌸 No worries, let’s try again. Please enter the task details once more!\n',
          },
        },
      ]
    }

    // If the user says "yes" to the task details, then retrieve all current tasks UIDs.
    else if (input === 'yes') {
      const newStateStack = replaceTopState(session, 'add_task_retrievedTaskUIDs')
      return [
        {
          json: {
            route: 'postgresNode',
            info: 'Fetching existing task UIDs before generating a new one. State becomes add_task_retrievedTaskUIDs',
            query: `
            UPDATE track_session
            SET context_data = jsonb_set(
              context_data,
              '{existing_task_uids}',
              (
                SELECT jsonb_agg(uid) FROM tasks
              )
            ),
            state = '${JSON.stringify(newStateStack)}'::jsonb,
            workflow_process = true,
            last_updated = NOW()
            WHERE user_id = '${currUserID}';
          `.trim(),
          },
        },
      ]
    }

    // If the user replies with anything other than "yes" or "no", tell them to enter again.
    else
      return [
        {
          json: {
            route: 'telegramNode',
            message:
              'Please only reply with either *yes* to confirm or *no* to re-enter task details.',
          },
        },
      ]
  }

  // 🌸 Flow: Add a new Task
  // State: add_task_retrievedTaskUIDs
  // Once we have retrieved all the tasks UIDs, generate a unique one and then enter the task
  // into the database
  // Next state: add_task_taskAdded
  if (currState === 'add_task_retrievedTaskUIDs') {
    const context = $('Updated Session').first().json.context_data || {}
    const selectedClient = context.selected_client
    const taskDetails = context.task_details
    const formattedDueDate = taskDetails.due ? convertToPostgresDate(taskDetails.due) : null
    const uidList = context.existing_task_uids

    // Generate Task UID (e.g., T4X2A)
    const taskUID = generateUID('T', uidList)
    const newStateStack = replaceTopState(session, 'add_task_taskAdded')

    return [
      {
        json: {
          route: 'postgresNode',
          info: 'Inserting new task into DB',
          query: `
            INSERT INTO tasks (uid, client_uid, title, due_date, priority, status, created_by)
            VALUES (
              '${taskUID}',
              '${selectedClient.uid}',
              '${taskDetails.title}',
              ${formattedDueDate ? `'${formattedDueDate}'` : 'NULL'},
              ${taskDetails.priority ? `'${taskDetails.priority}'` : 'NULL'},
              ${taskDetails.status ? `'${taskDetails.status}'` : 'NULL'},
              '${currUserID}'
            );`.trim(),
        },
      },
      {
        json: {
          route: 'postgresNode',
          info: 'Updating state after task added',
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
          message: `✅ Task added successfully!\n\n✨ Would you like to assign this task to someone?\n\n🧘‍♀️ Reply *yes* to assign.\n🌼 Reply *no* to skip.`,
        },
      },
    ]
  }

  // 🌸 Flow: Add a new Task
  // State: add_task_taskAdded
  // The task has been added and user was asked whether to assign it
  // If YES: Next state stack → add_task_assigningTaskAdded, assign_task
  // If NO: Pop the state and continue gracefully
  if (currState === 'add_task_taskAdded') {
    const input = currInput.trim().toLowerCase()

    if (input === 'yes') {
      const newStateStack = pushState(
        replaceTopState(session, 'add_task_assigningTaskAdded'),
        'assign_task'
      )

      return [
        {
          json: {
            route: 'postgresNode',
            info: 'User agreed to assign task — updating state stack to assign_task',
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
    } else if (input === 'no') {
      const poppedStateStack = popState(session)

      return [
        {
          json: {
            route: 'postgresNode',
            info: 'Popping taskAdded state, going back to session_ongoing',
            query: `
            UPDATE track_session
            SET state = '${JSON.stringify(poppedStateStack)}'::jsonb,
                workflow_process = false,
                last_updated = NOW()
            WHERE user_id = '${currUserID}';
          `.trim(),
          },
        },
      ]
    }

    // If neither yes nor no, ask again
    else
      return [
        {
          json: {
            route: 'telegramNode',
            message: `🤔 I didn’t catch that. Would you like to assign this task?\n\n🧘‍♀️ Reply *yes* to assign.\n🌼 Reply *no* to skip.`,
          },
        },
      ]
  }

  // 🌸 Flow: Add a new Task
  // State: add_task_assigningTaskAdded
  // Assign task step just got popped — now we pop this state too and return to main session
  if (currState === 'add_task_assigningTaskAdded') {
    const newStateStack = popState(session)

    return [
      {
        json: {
          route: 'postgresNode',
          info: 'Task assigned successfully, now returning to session flow',
          query: `
          UPDATE track_session
          SET state = '${JSON.stringify(newStateStack)}'::jsonb,
              workflow_process = false,
              last_updated = NOW()
          WHERE user_id = '${currUserID}';
        `.trim(),
        },
      },
    ]
  }

  // 🌸 Flow: Last Intention Ended
  // State: session_started
  // Ask the user if they would like to do anything else
  if (currState === 'session_started') {
    return [
      {
        json: {
          route: 'telegramNode',
          message: `🌟 Would you like to do anything else?\n\nTypes *yes* to confirm,\n🚪 Or type *no* to exit.`,
        },
      },
      {
        json: {
          route: 'postgresNode',
          info: `Proceed to next node that checks the user's reply, to do something else or end.`,
          query: `
          UPDATE track_session
          SET state = '["another_session_input"]'::jsonb,
              workflow_process = false,
              last_updated = NOW()
          WHERE user_id = '${currUserID}';
        `.trim(),
        },
      },
    ]
  }

  // 🌸 Flow: Ask user if they want to perform another action
  // State: another_session_input
  if (currState === 'another_session_input') {
    if (currInput.toLowerCase() === 'no') {
      const newStateStack = replaceTopState(session, 'session_ended')
      return [
        {
          json: {
            route: 'postgresNode',
            info: 'User chose to end session',
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
            message: `\n🙏 Thank you for using RI Task List Bot. The session has now ended.`,
          },
        },
      ]
    } else if (currInput.toLowerCase() === 'yes') {
      const newStateStack = replaceTopState(session, 'new_session')

      return [
        {
          json: {
            route: 'postgresNode',
            info: 'User chose to perform another action.',
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

    // If the user replies with anything other than "yes" or "no", tell them to enter again.
    else
      return [
        {
          json: {
            route: 'telegramNode',
            message:
              'Please only reply with either *yes* to confirm or *no* to re-enter task details.\n',
          },
        },
      ]
  }

  // 🌸 Flow: Start a new session since last one ended
  // State: session_ended
  if (currState === 'session_ended') {
    const newStateStack = replaceTopState(session, 'new_session')
    return [
      {
        json: {
          route: 'postgresNode',
          info: 'Starting new session from session_ended',
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

// Generate a new unique UID with given prefix and list
function generateUID(prefix, given_uidList) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

  let uid
  do {
    uid = prefix
    for (let i = 0; i < 4; i++) {
      uid += chars.charAt(Math.floor(Math.random() * chars.length))
    }
  } while (given_uidList.includes(uid))

  return uid
}

// This function is used to set the is_processing flag and
// work_process flag to false when exiting the workflow
function endWorkflowUpdate(currUserID) {
  return {
    json: {
      route: 'postgresNode',
      info: `Setting is_processing and workflow_process flag to false as exiting workflow`,
      query: `
        UPDATE track_session 
        SET workflow_process = false,
            is_processing = false,
        WHERE user_id = '${currUserID}';
      `.trim(),
    },
  }
}

// We use this function to convert DD-MM-YY format date to
// postgres format of YYYY-MM-DD
function convertToPostgresDate(ddmmyy) {
  const [dd, mm, yy] = ddmmyy.split('-').map(Number)
  const yyyy = 2000 + yy // Assuming 20YY; adjust if you're crossing centuries
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}
