const currUserTelegramID = $('Trigger upon receiving telegram message').first().json.message.from.id
const sessionData = $('Updated Session').first().json

// First we check if the track_session table returned empty data for the given telegram_id
// If yes, create a new row, and then proceed to logging in and state based logic
if (!sessionData || Object.keys(sessionData).length === 0 || !sessionData.telegram_id) {
  return [
    {
      // Add new row in track_session table
      json: {
        route: 'postgresNode',
        info: 'Inserting new row for new user into DB table track_session',
        query: String(
          `INSERT INTO track_session (telegram_id) VALUES ('${currUserTelegramID}');`.trim()
        ),
      },
    },
    // Inform the user that the task is added and ask for optional assignments
    telegramMessage(
      'Informing that this user is new and adding their row',
      `You are now registered. Please continue.`
    ),

    updateSessionQuery(
      'Ensure state is logged_out and context_data is empty',
      ['logged_out'],
      {},
      true,
      currUserTelegramID
    ),
  ]
}

// 📦 Extract commonly used session & user details from previous nodes
const session = $('Updated Session').first().json.state
// Extract current state from the state stack
const currState = peekState(session)
const context = $('Updated Session').first().json.context_data
const processing_flag = $('Updated Session').first().json.processing_flag
const currInput = $('Trigger upon receiving telegram message').first().json.message.text

// Check if the user is logged in
// If not, we execute the login flow
if ($('Updated Session').first().json.muid == null && processing_flag == true) {
  // State: logged_out
  // This is also the state when a new telegram_id has been entered
  // We simply go to asking for first name state
  if (currState === 'logged_out') {
    return [
      updateSessionQuery(
        'Starting new login state',
        ['login_askForFirstName'],
        {},
        true,
        currUserTelegramID
      ),
    ]
  }

  // State: login_askForFirstName
  // Next state: login_validateName
  // We also fetch all members' details at this state
  if (currState === 'login_askForFirstName') {
    const contextDataSQL = `
      jsonb_set(
        jsonb_set(
          coalesce(context_data, '{}'::jsonb),
          '{login}',
          '{}'::jsonb,
          true
        ),
        '{fetch_members}',
        jsonb_build_object('caller', 'login'),
        true
      )
    `

    const newStateStack = pushState(replaceTopState(session, `login_validateName`), `fetch_members`)
    return [
      telegramMessage(
        `Ask user for name`,
        `Welcome to RI Task List Bot\nPlease enter your first name to login.`
      ),
      updateSessionQuery(
        `Wait for name input`,
        newStateStack,
        contextDataSQL,
        false,
        currUserTelegramID
      ),
    ]
  }

  // State: login_validateName
  // Next state: login_performLogin (or) login_validateUID if name is not unique
  if (currState === `login_validateName`) {
    const userInput = currInput.trim().toLowerCase()
    const members = context.login.member_list

    // Filter matches by first name
    const matched = members.filter((m) => m.first_name.toLowerCase() === userInput)

    // If multiple matches found for the given first name, ask for UID
    if (matched.length > 1) {
      const contextDataSQL = `
      jsonb_set(
        jsonb_set(
          coalesce(context_data, '{}'::jsonb),
          '{login,entered_name}',
          '"${userInput}"'::jsonb,
          true
        ),
        '{login,ambiguous_name_matches}',
        '${JSON.stringify(matched)}'::jsonb,
        true
      )
    `

      return [
        telegramMessage(
          'Multiple name matches',
          `Multiple members found with the name "${userInput}".` +
            `\nPlease reply with your UID.\n\nor click /cancel to exit.`
        ),
        updateSessionQuery(
          'Ask for UID due to ambiguous name',
          ['login_validateUID'],
          contextDataSQL,
          false,
          currUserTelegramID
        ),
      ]
    }

    // Only one or zero match — proceed with login attempt later
    // (If no match, we will still pretend and fail only after password)
    const selectedUID = matched[0]?.uid || null

    let contextDataSQL = `
    jsonb_set(
      coalesce(context_data, '{}'::jsonb),
      '{login,entered_name}',
      '"${userInput}"'::jsonb,
      true
    )`

    if (selectedUID) {
      contextDataSQL = `
        jsonb_set(
          ${contextDataSQL},
          '{login,selected_member_uid}',
          '"${selectedUID}"'::jsonb,
          true
        )`
    }

    return [
      telegramMessage(
        'Request password',
        `Hello ${capitalize(userInput)}.\nPlease enter your password:`
      ),
      updateSessionQuery(
        'Ask for password and perform login next',
        ['login_performLogin'],
        contextDataSQL,
        false,
        currUserTelegramID
      ),
    ]
  }

  // State: login_validateUID
  // Save the UID since multiple members with given name were found and ask for password
  // Next state: login_performLogin
  if (currState === 'login_validateUID') {
    const userInput = currInput.trim().toLowerCase()

    if (userInput.replace('/', '') === 'cancel') {
      return [
        telegramMessage(
          'Cancel login flow',
          `Session Terminated.\nSend a message to try logging in again.`
        ),
        updateSessionQuery(
          'User cancelled login flow',
          ['logged_out'],
          `'{}'::jsonb`,
          false,
          currUserTelegramID
        ),
      ]
    }

    const matches = context.login.ambiguous_name_matches
    const selected = matches.find((m) => m.uid.toLowerCase() === userInput)

    if (!selected) {
      return [
        telegramMessage(
          'Invalid UID entered',
          `No matching UID found.\nPlease check and enter again.\n\nor click /cancel to exit.`
        ),
      ]
    }

    const contextDataSQL = `
      jsonb_set(
        coalesce(context_data, '{}'::jsonb),
        '{login,selected_member_uid}',
        '"${selected.uid}"'::jsonb,
        true
      )`

    return [
      telegramMessage(
        'Valid UID entered',
        `Thanks ${capitalize(selected.first_name)}.\nPlease enter your password:`
      ),
      updateSessionQuery(
        'Proceeding to check password and log in after UID confirmation',
        ['login_performLogin'],
        contextDataSQL,
        false,
        currUserTelegramID
      ),
    ]
  }

  // State: login_performLogin
  // Next state: new_session
  // State: login_performLogin
  // Validate password and complete login
  if (currState === 'login_performLogin') {
    const userPassword = currInput.trim()
    const members = context.login.member_list
    const uid = context.login.selected_member_uid

    const matched = members.find((m) => m.uid === uid)
    const failed = !matched || matched.password !== userPassword

    if (failed) {
      return [
        telegramMessage(
          `Login failed`,
          `Login failed. Invalid username or password.\nPlease try again.`
        ),
        updateSessionQuery(
          'Go back to logged_out after failed login',
          ['logged_out'],
          `'{}'::jsonb`,
          true,
          currUserTelegramID
        ),
      ]
    }

    return [
      telegramMessage('Login successful', `Logged in successfully`),
      {
        json: {
          route: 'updateSession',
          info: 'Update session to reflect logged-in user',
          query: `
            UPDATE track_session
            SET 
              muid = '${matched.uid}',
              state = '["new_session"]'::jsonb,
              context_data = '{}'::jsonb,
              processing_flag = true,
              last_updated = NOW()
            WHERE telegram_id = '${currUserTelegramID}';
            `.trim(),
        },
      },
    ]
  }
}

// Once user exists and is logged in, continue with the code's flow
const currUserName = $('Get User Details').first().json.first_name
const currRole = $('Get User Details').first().json.role
const currMemberID = $('Get User Details').first().json.uid // this means 5 digit member ID

if (processing_flag == true) {
  // If the user gave cancel command then quit the flow and inform the user
  if (String(currInput).trim().toLowerCase().replace('/', '') == 'cancel') {
    const newStateStack = ['session_ended']
    return [
      updateSessionQuery('User cancelled session', newStateStack, `'{}'::jsonb`, false),
      telegramMessage(
        'User chose to cancel session',
        'This session has been terminated.\nFeel free to start a new session 😃'
      ),
    ]
  }

  // 🌸 Start of the divine state based routing

  // Flow: Google Sheets Input
  // State: googleSheet_input_started
  if (currState === 'googleSheet_input_started') {
    const newStateStack = ['googleSheet_input_dataFetched']
    const contextDataSQL = `
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                coalesce(context_data, '{}'::jsonb),
                '{gSheetInput}',
                '{}'::jsonb,
                true
              ),
              '{fetch_assignments}',
              jsonb_build_object('caller', 'gSheetInput'),
              true
            ),
            '{fetch_clients}',
            jsonb_build_object('caller', 'gSheetInput'),
            true
          ),
          '{fetch_tasks}',
          jsonb_build_object('caller', 'gSheetInput'),
          true
        ),
        '{fetch_members}',
        jsonb_build_object('caller', 'gSheetInput'),
        true
      )
    `

    return [
      {
        json: {
          route: 'gSheetInput',
        },
      },
      updateSessionQuery(
        'Update state to data fetched for google sheet input',
        newStateStack,
        contextDataSQL,
        true
      ),
    ]
  }

  // Flow: Google Sheets Input
  if (currState === 'googleSheet_input_dataFetched') {
    // TODO
  }

  // Flow: Google Sheets Input
  if (currState === 'googleSheet_input_finished') {
    // TODO
  }

  // Flow: Google Sheets Output
  if (currState === 'googleSheet_output_started') {
    // TODO
  }

  // Flow: Google Sheets Output
  if (currState === 'googleSheet_output_dataFetched') {
    // TODO
  }

  if (currState === 'googleSheet_output_finished') {
    // TODO
  }

  // State: new_session
  // 🌸 If a new session has started, greet the user and ask them what they wish to do.
  // Next State: session_started
  if (currState === 'new_session') {
    const newStateStack = replaceTopState(session, 'session_started')
    return [
      {
        json: {
          route: 'greetNode',
        },
      },
      updateSessionQuery(
        'change state from new_session to session_started',
        newStateStack,
        `'{}'::jsonb`,
        false,
        currUserTelegramID
      ),
    ]
  }

  // State: session_started
  // 🌼 Once the user has selected a command, parse it and proceed accordingly
  // Next State Stack: session_ongoing, <interpreted from command>
  if (currState === 'session_started') {
    const nextState = getNextStateFromInput(currInput, currRole)

    if (nextState === 'invalid') {
      const newStateStack = replaceTopState(session, 'new_session')
      return [
        telegramMessage(
          `Informing user of invalid command`,
          `Hmm... I couldnt understand what you want.\n` +
            `Please choose from the options provided.`
        ),
        updateSessionQuery(
          'revert from session_started back to new_session because of invalid command',
          newStateStack,
          `'{}'::jsonb`,
          true,
          currUserTelegramID
        ),
      ]
    } else if (nextState === 'unauthorized') {
      const newStateStack = replaceTopState(session, 'new_session')
      return [
        telegramMessage(
          `Informing user of they are not authorized`,
          `Hmm...\nIt seems you are not authorized to do that.\n` +
            `Please choose from the options provided.`
        ),
        updateSessionQuery(
          `revert from session_started back to new_session because of invalid command`,
          newStateStack,
          `'{}'::jsonb`,
          true,
          currUserTelegramID
        ),
      ]
    } else {
      const newStateStack = pushState(replaceTopState(session, 'session_ongoing'), nextState)
      return [
        updateSessionQuery(
          `Updating state to push ${nextState} on the stack`,
          newStateStack,
          `'{}'::jsonb`,
          true,
          currUserTelegramID
        ),
      ]
    }
  }

  // 🌸 Flow: Add a new Task
  // State: add_task_started
  // If it has just started, retrieve the list of clients by calling the subflow
  // Next state stack: ..., add_task_retrievedClients, fetch_clients
  if (currState === 'add_task_started') {
    const newStateStack = pushState(
      replaceTopState(session, 'add_task_retrievedClients'),
      'fetch_clients'
    )
    return [
      updateSessionQuery(
        `Fetching clients for adding task by pushing fetch_clients on stack`,
        newStateStack,
        `
          jsonb_set(
            jsonb_set(
              COALESCE(context_data, '{}'::jsonb),
              '{add_task}',
              '{}'::jsonb,
              true
            ),
            '{fetch_clients}',
            jsonb_set(
              COALESCE(context_data->'fetch_clients', '{}'::jsonb),
              '{caller}',
              '"add_task"'::jsonb,
              true
            ),
            true
          )
        `,
        true
      ),
    ]
  }

  // 🌸 Flow: Add a new Task
  // State: add_task_retrievedClients
  // Once the client list has been fetched, prepare list and ask user to select one
  // Next state: add_task_selectedClient
  if (currState === 'add_task_retrievedClients') {
    const newStateStack = replaceTopState(session, 'add_task_checkSelectedClient')

    // Extract client list from context_data
    const clientList = Array.isArray(context.add_task.client_list)
      ? context.add_task.client_list
      : []

    const sortedClientList = clientList.sort((a, b) => a.name.localeCompare(b.name))

    const clientText = sortedClientList
      .map((client) => `🔹 ${client.name} (/${client.uid})`)
      .join('\n')

    // Prepare message to ask the user to choose a client from the list
    const message =
      `🌷 ${currUserName},\n` +
      `Please choose a client for this task:\n\n${clientText}\n\n` +
      `👉 Click on the *UID* next to the client's name.\n` +
      `🌱 Or click */new* to create a new client.`

    return [
      telegramMessage(`Sending list of clients to user and asking for selection`, message),
      updateSessionQuery(
        `Client List fetched. The user shall select a client. Updating state` +
          ` from add_task_retrievedClients to add_task_checkSelectedClient`,
        newStateStack,
        context,
        false
      ),
    ]
  }

  // 🌸 Flow: Add a new Task
  // State: add_task_checkSelectedClient
  // Once the user has entered a particular client, we check their validity and proceed accordingly.
  // Next state: add_task_askForTaskDetails
  if (currState === 'add_task_checkSelectedClient') {
    const clientInput = String(currInput).trim().toLowerCase().replace('/', '')

    // First check if user wants to add a new client and if so, proceed to the next state, calling add_client state on top
    if (clientInput === 'new') {
      const newStateStack = pushState(
        replaceTopState(session, 'add_task_askForTaskDetails'),
        'add_client_started'
      )

      return [
        updateSessionQuery(
          `add_task_checkSelectedClient: updating state to add_task_askForTaskDetails, add_client` +
            ` as user wants to add new client for the new task they are adding.`,
          newStateStack,
          `jsonb_strip_nulls(
            jsonb_set(
              jsonb_set(
                COALESCE(context_data, '{}'::jsonb),
                '{add_client}',
                jsonb_build_object('caller', 'add_task'),
                true
              ),
              '{add_task,client_list}',
              'null'::jsonb,
              true
            )
          )`,
          true
        ),
      ]
    }

    // Fetch client list and check whether entered client exists in the database
    const clientList = Array.isArray(context.add_task.client_list)
      ? context.add_task.client_list
      : []

    const foundClient = clientList.find((client) => client.uid.toLowerCase() === clientInput)

    if (!foundClient) {
      const revertStateStack = replaceTopState(session, 'add_task_retrievedClients')
      return [
        telegramMessage(
          'Client not found — prompting user to try again',
          `⚠️ Hmm, I couldn't find a client by that name or UID.\nPlease try again.`
        ),
        updateSessionQuery(
          `Invalid client input, reverting to add_task_retrievedClients`,
          revertStateStack,
          context,
          true
        ),
      ]
    }

    // Proceed if entered client UID is valid
    const newStateStack = replaceTopState(session, 'add_task_askForTaskDetails')
    return [
      updateSessionQuery(
        `Client ${foundClient.name} selected — saving in context_data and moving to ask for task details`,
        newStateStack,
        `jsonb_strip_nulls(
          jsonb_set(
            jsonb_set(
              context_data,
              '{add_task,client_list}',
              'null'::jsonb,
              true
            ),
            '{add_task,selected_client}',
            jsonb_build_object('uid', '${foundClient.uid}', 'name', '${foundClient.name}'),
            true
          )
        )`,
        true
      ),
      telegramMessage(
        `tell wonderful after selecting client to make them feel like a star`,
        `✨ Wonderful!`
      ),
    ]
  }

  // 🌸 Flow: Add a new Task
  // State: add_task_askForTaskDetails
  // We have the client for which the new task must be added, so now proceed to ask for the task details
  // Next state: add_task_askForTaskDetails
  if (currState === 'add_task_askForTaskDetails') {
    const newStateStack = replaceTopState(session, 'add_task_receivedTaskDetails')

    // Prepare Message to send to user - asking to enter task details with an example
    const taskMessage =
      `Please share the task details in *Key:Value* format.\n\nFor example:\n\n` +
      `*title*: Follow up with vendor\n` +
      `*due*: 22-06-25\n` +
      `*priority*: High\n` +
      `*notes*: Have to follow up with the vendor for photoshoot updates and inform the team\n\n` +
      `The due date can be either in DD-MM-YY format, a day of the week, today, or tomorrow.\n` +
      `The priority can be low, medium, high, or urgent.\n\n` +
      `🌼 Only *title* is required — the rest are optional and can be edited anytime.\n\n` +
      `Take your time. I'm right here when you're ready ✨`

    return [
      telegramMessage(`Asking user for task details`, taskMessage),
      updateSessionQuery(`User will enter task details now.`, newStateStack, context, false),
    ]
  }

  // 🌸 Flow: Add a new Task
  // State: add_task_receivedTaskDetails
  // Once the user has entered the new task's details, we parse and validate them, and proceed accordingly.
  // Next state: add_task_verifiedTaskDetails
  if (currState === 'add_task_receivedTaskDetails') {
    const taskText = String(currInput).trim()
    const selectedClient = context.add_task.selected_client

    // 🌿 Parse key:value input using helper function
    const parsedResult = parseKeyValueInput(taskText)

    // If the input is not correct, then inform the user and try again.
    if (!parsedResult.success) {
      const revertStateStack = replaceTopState(session, 'add_task_askForTaskDetails')
      return [
        telegramMessage(parsedResult.info, parsedResult.message),
        updateSessionQuery(parsedResult.info, revertStateStack, context, true),
      ]
    }

    // Test the parsed result for further validation
    const taskData = parsedResult.data
    const validation = validateTaskDetails(taskData)

    if (!validation.valid) {
      const revertStateStack = replaceTopState(session, 'add_task_askForTaskDetails')

      return [
        telegramMessage(validation.info, validation.message),
        updateSessionQuery(validation.info, revertStateStack, context, true),
      ]
    }

    const newStateStack = replaceTopState(session, 'add_task_verifiedTaskDetails')

    // Prepare task with client card to send to user asking to confirm insertion.
    const previewText = renderTasksView({
      clients: [{ uid: selectedClient.uid, name: selectedClient.name }],
      tasks: [
        {
          client_uid: selectedClient.uid,
          title: taskData.title,
          priority: taskData.priority ? `${taskData.priority}` : '',
          due: validation.dueDate ? `${cuteDate(validation.dueDate)}` : '',
        },
      ],
      assignments: [],
    })

    // 🌸 Add confirmation instructions
    const confirmMessage =
      previewText +
      `\n\n👥 —\n\n` +
      `If this looks good,\n✅ Click */yes* to confirm, or\n` +
      `🚫 Click */no* to enter task details again.`

    return [
      telegramMessage(
        'Confirming task details with user (yes/no) in formatted client card style',
        confirmMessage
      ),
      updateSessionQuery(
        `add_task_receivedTaskDetails: Saving task details into context_data. ` +
          `Asking user if task is okay to be entered, and proceeding to add_task_verifiedDetails`,
        newStateStack,
        `jsonb_set(
          context_data,
          '{add_task, task_details}',
          to_jsonb('${JSON.stringify(taskData)}'::json),
          true
        )`,
        false
      ),
    ]
  }

  // 🌸 Flow: Add a new Task
  // State: add_task_verifiedTaskDetails
  // Once the user's input of new task details are validated, we check the user's confirmation
  // and then fetch all tasks so that we can parse existing task UIDs and generate a unique one
  // Next state: add_task_retrievedTaskUIDs
  if (currState === 'add_task_verifiedTaskDetails') {
    const verifyTaskInput = String(currInput).trim().toLowerCase().replace('/', '')

    // If the user says "no" to the task details, then ask for it again
    if (verifyTaskInput === 'no') {
      const revertStateStack = replaceTopState(session, 'add_task_askForTaskDetails')
      return [
        telegramMessage(
          `Reverting back from add_task_verifiedTaskDetails to add_task_selectedClient since user said task details are not correct.`,
          `🌸 No worries, let's try again.`
        ),
        updateSessionQuery(
          'User rejected task details — cleaning up and retrying. State becomes add_task_selectedClient',
          revertStateStack,
          `
          jsonb_strip_nulls(
            jsonb_set(
              COALESCE(context_data, '{}'::jsonb),
              '{add_task,task_details}',
              'null'::jsonb,
              true
            )
          )
          `,
          true
        ),
      ]
    }

    // If the user says "yes" to the task details, then retrieve all current tasks UIDs.
    else if (verifyTaskInput === 'yes') {
      const newStateStack = pushState(
        replaceTopState(session, 'add_task_retrievedTaskUIDs'),
        'fetch_tasks'
      )
      return [
        updateSessionQuery(
          `add_task_verifiedTaskDetails: Fetching existing task UIDs before generating a new one.` +
            ` Calling fetch_tasks. State becomes add_task_retrievedTaskUIDs, fetch_tasks`,
          newStateStack,
          `
          jsonb_set(
            COALESCE(context_data, '{}'::jsonb),
            '{fetch_tasks}',
            jsonb_set(
              COALESCE(context_data->'fetch_tasks', '{}'::jsonb),
              '{caller}',
              '"add_task"'::jsonb,
              true
            ),
            true
          )
          `,
          true
        ),
      ]
    }
    // If the user replies with anything other than "yes" or "no", tell them to enter again.
    else
      return [
        telegramMessage(
          'User entered wrong input when asking if task details are correct.',
          'Please click either */yes* to confirm or */no* to re-enter task details. 👩‍🏫'
        ),
        updateSessionQuery(
          'User entered wrong input when asking if task details are correct.',
          session,
          context,
          false
        ),
      ]
  }

  // 🌸 Flow: Add a new Task
  // State: add_task_retrievedTaskUIDs
  // Once we have retrieved all the tasks UIDs, generate a unique one and then enter the task
  // into the database. Then, ask the user for assignments.
  // Next state: add_task_taskAdded
  if (currState === 'add_task_retrievedTaskUIDs') {
    const selectedClient = context.add_task.selected_client
    const taskDetails = context.add_task.task_details
    const formattedDueDate = taskDetails.due
      ? dateToYYMD(validateDueDate(taskDetails.due).parsedDate)
      : null
    const taskPriority = taskDetails.priority ? taskDetails.priority : 'medium'

    // Generate Task UID (e.g., T4X2A)
    const tasksUIDList = context.add_task.task_list.map((task) => task.uid)
    const taskUID = generateUID('T', tasksUIDList)
    const newStateStack = pushState(replaceTopState(session, 'add_task_taskAdded'), 'fetch_tasks')

    const fields = {
      uid: taskUID,
      client_uid: selectedClient.uid,
      title: taskDetails.title,
      due_date: formattedDueDate ? `'${formattedDueDate}'` : 'NULL',
      priority: taskPriority,
      status: 'pending',
      created_by: currMemberID,
    }

    return [
      {
        // Add new task into the database - tasks table
        json: {
          route: 'postgresNode',
          info: 'Inserting new task into DB table tasks',
          query: String(
            `
            INSERT INTO tasks (uid, client_uid, title, due_date, priority, status, created_by)
            VALUES (
              '${fields.uid}',
              '${fields.client_uid}',
              '${fields.title}',
              ${fields.due_date},
              '${fields.priority}',
              '${fields.status}',
              '${fields.created_by}'
            );`.trim()
          ),
        },
      },
      // Inform the user that the task is added and ask for optional assignments
      telegramMessage(
        'Asking user if they want to assign newly added task',
        `✅ Task added successfully!\n\n✨ Would you like to assign this task to someone?\n\n` +
          `🧘‍♀️ Click */yes* to assign.\n🌼 Click */no* to skip.`
      ),
      updateSessionQuery(
        `Updating state after task added`,
        newStateStack,
        `
          jsonb_set(
            jsonb_set(
              jsonb_set(
                COALESCE(context_data, '{}'::jsonb),
                '{add_task,task_list}',
                'null'::jsonb,
                true
              ),
              '{add_task,task_details,new_uid}',
              to_jsonb('${taskUID}'::text),
              true
            ),
            '{fetch_tasks}',
            jsonb_build_object('caller', 'add_task'),
            true
          )
        `,
        false
      ),
    ]
  }

  // 🌸 Flow: Add a new Task
  // State: add_task_taskAdded
  // The task has been added and user was asked whether to assign it
  // If YES: Next state stack → ..., add_task_assignedTaskAdded, assign_task_retrievedMembersList, fetch_members
  // If NO: Pop the state and continue gracefully
  if (currState === 'add_task_taskAdded') {
    const input = String(currInput).trim().toLowerCase().replace('/', '')

    if (input === 'yes') {
      const newStateStack = pushState(
        pushState(
          replaceTopState(session, 'add_task_assignedTaskAdded'),
          'assign_task_retrievedMembersList'
        ),
        'fetch_members'
      )

      const taskList = context.add_task?.task_list || []
      const newTaskUID = context.add_task?.task_details?.new_uid
      const selectedTask = taskList.find((t) => t.uid === newTaskUID)
      const selectedClient = context.add_task?.selected_client

      const contextDataSQL = `
        jsonb_strip_nulls(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                coalesce(context_data, '{}'::jsonb),
                '{assign_task}',
                jsonb_build_object(
                  'selected_task', jsonb_build_object(
                    'uid', ${selectedTask.uid ? `'${selectedTask.uid}'` : 'null'},
                    'title', ${selectedTask.title ? `'${selectedTask.title}'` : 'null'},
                    'due_date', ${selectedTask.due_date ? `'${selectedTask.due_date}'` : 'null'},
                    'priority', ${selectedTask.priority ? `'${selectedTask.priority}'` : 'null'},
                    'client_uid', ${selectedTask.client_uid ? `'${selectedTask.client_uid}'` : 'null'},
                  ),
                  'selected_client', jsonb_build_object(
                    'uid', '${selectedClient.uid}',
                    'name', '${selectedClient.name}'
                  ),
                  'caller', 'add_task'
                ),
                true
              ),
              '{fetch_members}',
              jsonb_build_object('caller', 'assign_task'),
              true
            ),
            '{add_task}',
            'null'::jsonb,
            true
          )
        )
      `

      return [
        updateSessionQuery(
          `User agreed to assign task — preparing context_data for assign_task`,
          newStateStack,
          contextDataSQL,
          true
        ),
      ]
    } else if (input === 'no') {
      const poppedStateStack = popState(session)

      return [
        updateSessionQuery(
          'Popping taskAdded state, going back to session_ongoing',
          poppedStateStack,
          `jsonb_strip_nulls(
            jsonb_set(
              COALESCE(context_data, '{}'::jsonb),
              '{add_task}',
              'null'::jsonb,
              true
            )
          )`,
          true
        ),
        telegramMessage(
          'inform user that task is added and go to menu',
          '✅ The new task was added successfully 🎈'
        ),
      ]
    }

    // If neither yes nor no, ask again
    else
      return [
        telegramMessage(
          `User entered wrong input when asking if they want to assign the task. Asking again.`,
          `🤔 I didn't catch that. Would you like to assign this task?\n\n` +
            `🧘‍♀️ Click */yes* to assign.\n🌼 Click */no* to skip.`
        ),
        updateSessionQuery(
          'User entered wrong input when asking if they want to assign the task. Asking again.',
          session,
          context,
          false
        ),
      ]
  }

  // 🌸 Flow: Add a new Task
  // State: add_task_assignedTaskAdded
  // Assign task step just got popped — now we pop this state too and return to main session
  if (currState === 'add_task_assignedTaskAdded') {
    const newStateStack = popState(session)
    return [
      updateSessionQuery(
        'The new task added was assigned successfully, now popping back to session_ongoing.\n',
        newStateStack,
        `jsonb_strip_nulls(
          jsonb_set(
            COALESCE(context_data, '{}'::jsonb),
            '{add_task}',
            'null'::jsonb,
            true
          )
        )`,
        true
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_started
  // Started assigning an existing task, we fetch client list to ask user
  // Next state stack: ..., assign_task_retrievedClientandTaskList, fetch_clients, fetch_tasks
  if (currState === 'assign_task_started') {
    const newStateStack = pushState(
      pushState(
        replaceTopState(session, 'assign_task_retrievedClientandTaskList'),
        'fetch_clients'
      ),
      'fetch_tasks'
    )
    return [
      updateSessionQuery(
        `Fetching clients and tasks for assigning task. Pushing fetch_clients and fetch_tasks on stack`,
        newStateStack,
        `
          jsonb_set(
            jsonb_set(
              jsonb_set(
                COALESCE(context_data, '{}'::jsonb),
                '{assign_task}',
                COALESCE(context_data->'assign_task', '{}'::jsonb),
                true
              ),
              '{fetch_clients}',
              jsonb_set(
                COALESCE(context_data->'fetch_clients', '{}'::jsonb),
                '{caller}',
                '"assign_task"'::jsonb,
                true
              ),
              true
            ),
            '{fetch_tasks}',
            jsonb_set(
              COALESCE(context_data->'fetch_tasks', '{}'::jsonb),
              '{caller}',
              '"assign_task"'::jsonb,
              true
            ),
            true
          )
        `,
        true
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_retrievedClientandTaskList
  // Retrieved list of clients. Prepare message and ask user to select with clickable UIDs
  // Next state: ..., assign_task_selectedClient
  if (currState === 'assign_task_retrievedClientandTaskList') {
    const newStateStack = replaceTopState(session, 'assign_task_selectedClient')

    // 🌼 Extract client list and task list from context_data
    const clientList = Array.isArray(context.assign_task?.client_list)
      ? context.assign_task.client_list
      : []

    const taskList = Array.isArray(context.assign_task?.task_list)
      ? context.assign_task.task_list
      : []

    // 🌼 Build a Set of client UIDs who have tasks
    const clientsWithTasks = new Set(taskList.map((task) => task.client_uid))

    // 🌼 Filter the clients to only those with at least one task
    const filteredClientList = clientList.filter((client) => clientsWithTasks.has(client.uid))

    // 🌼 Sort the filtered list by client name
    const sortedClientList = filteredClientList.sort((a, b) => a.name.localeCompare(b.name))

    const clientText = sortedClientList
      .map((client) => `🔹 ${client.name} (/${client.uid})`)
      .join('\n')

    const message =
      `🌷 ${currUserName},\n` +
      `Please choose the client to whom the task to be assigned belongs to:\n\n${clientText}\n\n` +
      `👉 Click on the client's UID displayed next to their name.\n\n` +
      `Note: Only the clients having at least one task have been displayed.`

    return [
      telegramMessage(
        `Sending filtered list of clients who have tasks to user and asking for selection`,
        message
      ),
      updateSessionQuery(
        `Filtered client list to only those with tasks. Updated state from assign_task_retrievedClientandTaskList to assign_task_selectedClient`,
        newStateStack,
        context,
        false
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_selectedClient
  // User selected a client, validate it and then insert it into context_data, delete client_list.
  // Fetch task list to ask the user
  // Next state stack: ..., assign_task_askToSelectTask
  if (currState === 'assign_task_selectedClient') {
    const clientInput = String(currInput).trim().toLowerCase().replace('/', '')

    // Fetch client list and check whether entered client exists in the database
    const clientList = Array.isArray(context.assign_task.client_list)
      ? context.assign_task.client_list
      : []

    const foundClient = clientList.find(
      (client) => client.uid.toLowerCase() === clientInput.toLowerCase()
    )

    if (!foundClient) {
      const revertStateStack = replaceTopState(session, 'assign_task_retrievedClientandTaskList')
      return [
        telegramMessage(
          'Client not found — prompting user to try again',
          `⚠️ Hmm..\nI couldn't find a client by that UID.\nPlease try again.`
        ),
        updateSessionQuery(
          `Invalid client input, reverting to add_task_retrievedClients`,
          revertStateStack,
          context,
          true
        ),
      ]
    }

    const newStateStack = replaceTopState(session, 'assign_task_askToSelectTask')
    return [
      updateSessionQuery(
        `Client ${foundClient.name} selected — saving in context_data and moving to assign_task_askToSelectTask`,
        newStateStack,
        // We remove client_list and add selected_client
        `
          jsonb_strip_nulls(
            jsonb_set(
              jsonb_set(
                context_data,
                '{assign_task,client_list}',
                'null'::jsonb,
                true
              ),
              '{assign_task,selected_client}',
              jsonb_build_object('uid', '${foundClient.uid}', 'name', '${foundClient.name}'),
              true
            )
          )
        `,
        true
      ),
      telegramMessage(
        `tell wonderful after selecting client to make the user feel like a star`,
        `✨ Wonderful!`
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_askToSelectTask
  // Show user all the tasks and ask them to select one with clickable task UID
  // Next state stack: ..., assign_task_selectedTask
  if (currState === 'assign_task_askToSelectTask') {
    const newStateStack = replaceTopState(session, 'assign_task_selectedTask')

    // 🌼 Extract task list from context_data
    const taskList = Array.isArray(context.assign_task?.task_list)
      ? context.assign_task.task_list
      : []

    // 🌼 Extract selected client UID to filter tasks for that client
    const selectedClientUID = context.assign_task?.selected_client?.uid

    // 🌼 Filter tasks belonging to selected client
    const filteredTaskList = taskList.filter(
      (task) => task.client_uid.toLowerCase() === selectedClientUID.toLowerCase()
    )

    // 🌼 Sort filtered tasks by title
    const sortedTaskList = filteredTaskList.sort((a, b) => a.title.localeCompare(b.title))

    // 🌼 Prepare task display text
    const taskText = sortedTaskList.map((task) => `🔹 ${task.title} (/${task.uid})`).join('\n')

    // 🌼 Prepare message for user
    const message =
      `Please choose the task you wish to assign:\n\n${taskText}\n\n` +
      `👉 Click on the task's UID displayed next to its title.`

    return [
      telegramMessage(`Sending list of tasks to user and asking for selection`, message),
      updateSessionQuery(
        `Filtered task list for client UID ${selectedClientUID}. Awaiting user's task selection.`,
        newStateStack,
        context,
        false
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_selectedTask
  // User selected a task, validate it and fetch list of members to ask the user
  // Insert the task into context_data and delete the task_list
  // Next state stack: ..., assign_task_retrievedMembersList, fetch_members
  if (currState === 'assign_task_selectedTask') {
    const taskInput = String(currInput).trim().toLowerCase().replace('/', '')

    const taskList = Array.isArray(context.assign_task?.task_list)
      ? context.assign_task.task_list
      : []

    const selectedClientUID = context.assign_task?.selected_client?.uid

    // Filter tasks belonging to the selected client
    const filteredTaskList = taskList.filter(
      (task) => task.client_uid.toLowerCase() === selectedClientUID.toLowerCase()
    )

    // Try to find task with matching UID
    const selectedTask = filteredTaskList.find(
      (task) => task.uid.toLowerCase() === taskInput.toLowerCase()
    )

    // If task is not found, ask user to re-enter
    if (!selectedTask) {
      const revertStateStack = replaceTopState(session, `assign_task_askToSelectTask`)
      return [
        telegramMessage(
          'Invalid task UID entered',
          `❌ That doesn't seem like a valid task UID.\nPlease click on a task's UID from the list.`
        ),
        updateSessionQuery(
          `Invalid client input, reverting to add_task_retrievedClients`,
          revertStateStack,
          context,
          true
        ),
      ]
    }

    const newStateStack = pushState(
      replaceTopState(session, 'assign_task_retrievedMembersList'),
      'fetch_members'
    )
    const updateContextQuery = `
    jsonb_strip_nulls(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            context_data,
            '{assign_task,task_list}',
            'null'::jsonb,
            true
          ),
          '{assign_task,selected_task}',
          jsonb_build_object(
            'uid', '${selectedTask.uid}',
            'title', '${selectedTask.title}',
            'client_uid', '${selectedTask.client_uid}',
            'due_date', '${selectedTask.due_date}',
            'priority', '${selectedTask.priority}'
          ),
          true
        ),
        '{fetch_members}',
        jsonb_build_object('caller', 'assign_task'),
        true
      )
    )`

    return [
      updateSessionQuery(
        `Task selected (${selectedTask.uid}). Pushing fetch_members to fetch team list.`,
        newStateStack,
        updateContextQuery,
        true
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_retrievedMembersList
  // Show members list with clickable member UID and ask them to select one
  // Next state stack: ..., assign_task_selectedMember
  if (currState === 'assign_task_retrievedMembersList') {
    const newStateStack = replaceTopState(session, 'assign_task_selectedMember')
    const memberList = Array.isArray(context.assign_task?.member_list)
      ? context.assign_task.member_list
      : []

    // 🌼 Sort members by first_name
    const sortedmemberList = memberList.sort((a, b) => a.first_name.localeCompare(b.first_name))

    // 🌼 Prepare members display text
    const memberText = sortedmemberList
      .map((member) => `🔹 ${member.first_name} (/${member.uid})`)
      .join('\n')

    // 🌼 Prepare message for user
    const message =
      `Please choose a 👥 member to assign this task to:\n\n${memberText}\n\n` +
      `👉 Click on the member's UID displayed next to their name.`

    return [
      telegramMessage(`Sending list of members to user and asking for selection`, message),
      updateSessionQuery(
        `Awaiting user's member selection for assigning the task.`,
        newStateStack,
        context,
        false
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_selectedMember
  // User selected a member, validate it and then ask the user for further assignment details or skip
  // Next state stack: ..., assign_task_askForAssignmentDetails
  if (currState === 'assign_task_selectedMember') {
    const memberInput = String(currInput).trim().toLowerCase().replace('/', '')

    const memberList = Array.isArray(context.assign_task?.member_list)
      ? context.assign_task.member_list
      : []

    // Try to find member with matching UID
    const selectedMember = memberList.find(
      (member) => member.uid.toLowerCase() === memberInput.toLowerCase()
    )

    // If member is not found, ask user to re-enter
    if (!selectedMember) {
      const revertStateStack = replaceTopState(session, 'assign_task_retrievedMembersList')
      return [
        telegramMessage(
          'Invalid member UID entered',
          `❌ That doesn't seem like a valid member UID.\nPlease click on a member UID from the list.`
        ),
        updateSessionQuery(
          `Invalid member input, reverting to assign_task_retrievedMembersList`,
          revertStateStack,
          context,
          true
        ),
      ]
    }

    const newStateStack = replaceTopState(session, 'assign_task_askForAssignmentDetails')

    // 🌼 Add selected member to context_data
    const updateContextQuery = `
      jsonb_set(
        context_data,
        '{assign_task,selected_member}',
        jsonb_build_object(
          'uid', '${selectedMember.uid}',
          'first_name', '${selectedMember.first_name}'
        ),
        true
      )`

    return [
      updateSessionQuery(
        `Member selected: ${selectedMember.uid}. Moving to assign_task_askForAssignmentDetails`,
        newStateStack,
        updateContextQuery,
        true
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_askForAssignmentDetails
  // 🌼 Ask user for assignment-specific details or /skip
  // Separated from assign_task_selectedMember so that if user enters details incorrectly,
  // we just ask again and the member validation bit doesn't happen
  // Next state stack: ..., assign_task_confirmAssignmentDetails
  if (currState === 'assign_task_askForAssignmentDetails') {
    // 🌼 Ask user for assignment-specific details
    const detailsMessage =
      `✨ Almost there! Let's add a few optional details for this assignment:\n\n` +
      `Please use *Key:Value* format. For example:\n\n` +
      `*resp*: Call client and update sheet\n` +
      `*priority*: High\n` +
      `*due*: 01-07-25\n\n` +
      `(resp - short for responsibility)\n\n` +
      `🌱 You can type any or all. To skip, simply click here → */skip*.`

    const newStateStack = replaceTopState(session, 'assign_task_confirmAssignmentDetails')

    return [
      telegramMessage('Asking user for assignment-specific details', detailsMessage),
      updateSessionQuery(
        `Asked user to enter assignment details. Moving to assign_task_confirmAssignmentDetails`,
        newStateStack,
        context,
        false
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_confirmAssignmentDetails
  // Validate the assignment details entered by the user or /skip.
  // Insert the assignment details into context_data
  // Ask the user to confirm assignment
  // Next state stack: ..., assign_task_validatedAssignmentDetails
  if (currState === 'assign_task_confirmAssignmentDetails') {
    const assignmentDetailsInput = String(currInput).trim()

    const newStateStack = pushState(
      replaceTopState(session, 'assign_task_validatedAssignmentDetails'),
      'fetch_assignments'
    )

    const selectedTask = context.assign_task.selected_task
    const selectedClient = context.assign_task.selected_client
    const selectedMember = context.assign_task.selected_member

    let due = null

    if (selectedTask.due_date && selectedTask.due_date !== 'undefined')
      due = cuteDate(YYMDtoDMY(selectedTask.due_date))

    // 🧚 If user skipped input
    if (assignmentDetailsInput.toLowerCase() === '/skip') {
      const previewText = renderTasksView({
        clients: [{ uid: selectedClient.uid, name: selectedClient.name }],
        tasks: [
          {
            uid: selectedTask.uid,
            client_uid: selectedTask.client_uid,
            title: selectedTask.title,
            priority: selectedTask.priority,
            due: due,
            status: selectedTask.status,
            notes: selectedTask.notes,
          },
        ],
        assignments: [
          {
            task_uid: selectedTask.uid,
            first_name: selectedMember.first_name,
          },
        ],
      })

      // 🌸 Add confirmation instructions
      const confirmMessage =
        previewText +
        `\n\n\n🌿 No extra assignment details provided.\nDefault values will be used.\n\n` +
        `✅\tClick */yes* to confirm assignment.\n🚫\tClick */no* to re-enter.`

      return [
        telegramMessage(`Asking user to confirm assignment after /skip`, confirmMessage),
        updateSessionQuery(
          `User skipped assignment details. Proceeding to validatedAssignmentDetails and fetch_assignments`,
          newStateStack,
          `
            jsonb_set(
              jsonb_set(
                context_data,
                '{assign_task,assignment_details}',
                '{"resp": null, "priority": null, "due": null}'::jsonb,
                true
              ),
              '{fetch_assignments}',
              jsonb_build_object('caller', 'assign_task'),
              true
            )
          `,
          false
        ),
      ]
    }

    // 🌿 Parse user input
    const parsedResult = parseKeyValueInput(assignmentDetailsInput)
    if (!parsedResult.success) {
      const revertStateStack = replaceTopState(session, 'assign_task_askForAssignmentDetails')
      return [
        telegramMessage(parsedResult.info, parsedResult.message),
        updateSessionQuery(parsedResult.info, revertStateStack, context, true),
      ]
    }

    const data = parsedResult.data
    const allowedKeys = ['resp', 'priority', 'due']
    const invalidKeys = Object.keys(data).filter((k) => !allowedKeys.includes(k))

    if (invalidKeys.length > 0) {
      const revertStateStack = replaceTopState(session, 'assign_task_askForAssignmentDetails')
      return [
        telegramMessage(
          `Invalid fields entered`,
          `❌ Unknown field(s): *${invalidKeys.join(', ')}*\nPlease use only: *resp, priority, due*`
        ),
        updateSessionQuery(`Invalid fields in assignment input`, revertStateStack, context, true),
      ]
    }

    const dateValidation = data.due ? validateDueDate(data.due) : null
    if (data.due && !dateValidation.valid) {
      const revertStateStack = replaceTopState(session, 'assign_task_askForAssignmentDetails')
      return [
        telegramMessage(
          `Invalid due date.\nReason: ${dateValidation.reason}`,
          `📅 The due date "${data.due}" isn't valid.\nReason: ${dateValidation.reason}`
        ),
        updateSessionQuery(`Invalid due date`, revertStateStack, context, true),
      ]
    }

    const allowedPriorities = ['low', 'medium', 'high', 'urgent']
    if (data.priority && !allowedPriorities.includes(data.priority.toLowerCase())) {
      const revertStateStack = replaceTopState(session, 'assign_task_askForAssignmentDetails')
      return [
        telegramMessage(
          `Invalid priority`,
          `🔺 The priority "${data.priority}" is not valid.\nChoose one of: *low, medium, high, urgent*.`
        ),
        updateSessionQuery(`Invalid priority level entered`, revertStateStack, context, true),
      ]
    }

    const previewText = renderTasksView({
      clients: [{ uid: selectedClient.uid, name: selectedClient.name }],
      tasks: [
        {
          uid: selectedTask.uid,
          client_uid: selectedTask.client_uid,
          title: selectedTask.title,
          priority: selectedTask.priority,
          due: selectedTask.due_date ? cuteDate(YYMDtoDMY(selectedTask.due_date)) : null,
          status: selectedTask.status,
          notes: selectedTask.notes,
        },
      ],
      assignments: [
        {
          task_uid: selectedTask.uid,
          first_name: selectedMember.first_name,
          resp: data.resp,
          due: cuteDate(dateToDMY(dateValidation.parsedDate)),
          priority: data.priority,
        },
      ],
    })

    // 🌸 Add confirmation instructions
    const confirmMessage =
      previewText + `\n\n✅ Click */yes* to confirm assignment.\n🚫 Click */no* to re-enter.`

    return [
      telegramMessage(`Confirming assignment with user`, confirmMessage),
      updateSessionQuery(
        `Valid assignment details received. Proceeding to validatedAssignmentDetails`,
        newStateStack,
        `
          jsonb_set(
            jsonb_set(
              context_data,
              '{assign_task,assignment_details}',
              to_jsonb('${JSON.stringify(data)}'::json),
              true
            ),
            '{fetch_assignments}',
            jsonb_build_object('caller', 'assign_task'),
            true
          )
        `,
        false
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_validatedAssignmentDetails
  // We are ready to assign the task to the user, so execute the INSERT SQL Query
  // Next state stack: ..., assign_task_postInsert
  if (currState === 'assign_task_validatedAssignmentDetails') {
    const response = String(currInput).trim().toLowerCase().replace('/', '')

    if (response === 'no') {
      const revertStateStack = replaceTopState(session, 'assign_task_askForAssignmentDetails')
      return [
        telegramMessage(
          `User wants to enter assignment details again.`,
          `🌸 No worries, let's try again.`
        ),
        updateSessionQuery(
          `User chose to re-enter assignment details. Reverting to assign_task_askForAssignmentDetails`,
          revertStateStack,
          `
            jsonb_set(
              context_data,
              '{assign_task,assignment_details}',
              'null'::jsonb,
              true
            )
          `,
          true
        ),
      ]
    }

    if (response !== 'yes') {
      return [
        telegramMessage(
          `Invalid response`,
          `Please click */yes* to confirm the assignment, or */no* to re-enter details.`
        ),
      ]
    }

    // 🌼 Pull details from context
    const task = context.assign_task?.selected_task
    const member = context.assign_task?.selected_member
    const details = context.assign_task?.assignment_details
    const formattedDueDate = details.due
      ? dateToYYMD(validateDueDate(details.due).parsedDate)
      : null

    // 🌼 Pull existing assignment UIDs from context
    const assignmentUIDList = (context.assign_task?.assignment_list || []).map((a) => a.uid) || []
    // 🌟 Generate a unique assignment UID
    const assignmentUID = generateUID('A', assignmentUIDList) // 'A' for Assignment

    // 🌼 Generate INSERT query for task_assignments
    const insertAssignmentQuery = `INSERT INTO task_assignments (
      uid,
      task_uid,
      member_uid,
      assigned_by,
      status,
      resp,
      due_date,
      priority
    )
    VALUES (
      '${assignmentUID}',
      '${task.uid}',
      '${member.uid}',
      '${currMemberID}',
      'pending',
      ${details.resp ? `'${details.resp.replace(/'/g, "''")}'` : 'NULL'},
      ${formattedDueDate ? `'${formattedDueDate}'` : 'NULL'},
      ${details.priority ? `'${details.priority.toLowerCase()}'` : `'medium'`}
    )`

    const newStateStack = replaceTopState(session, 'assign_task_postInsert')

    return [
      {
        json: {
          route: 'postgresNode',
          info: 'Inserting new assignment into DB table task_assignments',
          query: String(insertAssignmentQuery.trim()),
        },
      },
      updateSessionQuery(
        `Assignment inserted into DB. Proceeding to postInsert`,
        newStateStack,
        `jsonb_strip_nulls(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                context_data,
                '{assign_task,selected_member}',
                'null'::jsonb,
                true
              ),
              '{assign_task,assignment_details}',
              'null'::jsonb,
              true
            ),
            '{assign_task,assignment_list}',
            'null'::jsonb,
            true
          )
        )`,
        false
      ),
      telegramMessage(
        `✨ Assignment Confirmed!`,
        `🌟 Task ${task.title} has been assigned to ${member.first_name} successfully!\n\n` +
          `Do you want to assign this task to another member?\n\n` +
          `✅\t*/yes*\n🚫\t*/no*`
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_postInsert
  // Task Assigned, ask if the user wants to assign this task to another member
  // If yes:  Next state stack: ..., assign_task_retrievedMemberList
  // If no:   Next state stack: ..., assign_task_taskAssigned
  if (currState === 'assign_task_postInsert') {
    const response = String(currInput).trim().toLowerCase().replace('/', '')

    if (response === 'no') {
      const newStateStack = replaceTopState(session, 'assign_task_taskAssigned')
      return [
        updateSessionQuery(
          `User does not want to assign more members. Moving to assign_task_taskAssigned`,
          newStateStack,
          context,
          true
        ),
      ]
    }

    if (response === 'yes') {
      const newStateStack = replaceTopState(session, 'assign_task_retrievedMembersList')
      return [
        telegramMessage(
          `Assigning to more members`,
          `👥 Lovely! Let's assign this task to another team member.`
        ),
        updateSessionQuery(
          `User wants to assign the same task to another member. Going to retrievedMembersList`,
          newStateStack,
          context,
          true
        ),
      ]
    }

    // 🌸 If input is invalid
    return [
      telegramMessage(
        `Invalid response`,
        `Please click */yes* to assign to another member or */no* to finish.`
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_taskAssigned
  // All done, inform the user and pop
  // Next state stack: ... (pop)
  if (currState === 'assign_task_taskAssigned') {
    const newStateStack = popState(session)

    return [
      telegramMessage(`Assignment completed`, `🎉 The task has been successfully assigned.`),
      updateSessionQuery(
        `All assignment steps done. Cleaning up and popping state.`,
        newStateStack,
        `jsonb_strip_nulls(
          jsonb_set(
            context_data,
            '{assign_task}',
            null::jsonb,
            true
          )
        )`,
        true
      ),
    ]
  }

  // 🌸 Flow: Viewing Tasks
  // State: view_tasks_started
  // The user has selected "🔍 View Tasks" from the greeting menu
  // We shall fetch all the info from the database and keep it ready
  // Next state stack: ..., view_tasks_retrievedData, fetch_members, fetch_tasks, fetch_clients, fetch_assignments
  if (currState === 'view_tasks_started') {
    const newStateStack = pushState(
      pushState(
        pushState(
          pushState(replaceTopState(session, 'view_tasks_retrievedData'), 'fetch_members'),
          'fetch_tasks'
        ),
        'fetch_clients'
      ),
      'fetch_assignments'
    )

    const contextDataSQL = `
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                coalesce(context_data, '{}'::jsonb),
                '{view_tasks}',
                '{}'::jsonb,
                true
              ),
              '{fetch_assignments}',
              jsonb_build_object('caller', 'view_tasks'),
              true
            ),
            '{fetch_clients}',
            jsonb_build_object('caller', 'view_tasks'),
            true
          ),
          '{fetch_tasks}',
          jsonb_build_object('caller', 'view_tasks'),
          true
        ),
        '{fetch_members}',
        jsonb_build_object('caller', 'view_tasks'),
        true
      )
    `

    return [
      updateSessionQuery(
        'User selected view tasks — setting up fetch flows with view_tasks as caller',
        newStateStack,
        contextDataSQL,
        true
      ),
    ]
  }

  // 🌸 Flow: Viewing Tasks
  // State: view_tasks_started
  // We have fetched all the data from the database
  // Now we shall ask the user to input what filter they want to put or /all → store it in context_data
  // Next state stack: ..., view_tasks_askFilterValue
  if (currState === 'view_tasks_retrievedData') {
    const newStateStack = replaceTopState(session, 'view_tasks_askFilterValue')

    return [
      telegramMessage(
        `Asking user to select a filter to view tasks`,
        `⚙️ How would you like to *filter* the tasks?\n\n` +
          `• */client*\n` +
          `• */due*\n` +
          `• */member*\n` +
          `• */priority*\n` +
          `• */status*\n\n` +
          `🌿 Or */all* to view all pending tasks`
      ),
      updateSessionQuery(
        `User is being asked to choose a task filter — proceeding to askFilterValue`,
        newStateStack,
        context,
        false
      ),
    ]
  }

  // 🌸 Flow: Viewing Tasks
  // State: view_tasks_started
  // The user has select their filter. We will ask to enter filter value → store it in context_data
  // Next state stack: ..., view_tasks_validateFilter
  if (currState === 'view_tasks_askFilterValue') {
    const selectedFilter = String(currInput).trim().toLowerCase().replace('/', '')
    const allowedFilters = ['all', 'client', 'due', 'member', 'status', 'priority']

    if (!allowedFilters.includes(selectedFilter)) {
      const revertStateStack = replaceTopState(session, 'view_tasks_retrievedData')
      return [
        telegramMessage(
          `User entered invalid filter option in view_tasks_askFilterValue`,
          `🤔 I didn't understand that.\nLet's try again.`
        ),
        updateSessionQuery(
          `Invalid filter option entered, retrying`,
          revertStateStack,
          context,
          true
        ),
      ]
    }

    const newStateStack = replaceTopState(session, 'view_tasks_validateFilter')

    const updatedContext = {
      ...context,
      view_tasks: {
        ...(context.view_tasks || {}),
        selected_filter: selectedFilter,
      },
    }

    // 🍃 Case 1: No filter - show all
    if (selectedFilter === 'all') {
      return [
        updateSessionQuery(
          `User selected no filter (/all). Proceeding to validateFilter`,
          newStateStack,
          updatedContext,
          true
        ),
      ]
    }

    // 👨‍💼 Case 2: Client Filter
    if (selectedFilter === 'client') {
      const clientList = context.view_tasks?.client_list || []
      const taskList = context.view_tasks?.task_list || []

      // 🌼 Build a Set of client UIDs who have tasks
      const clientsWithTasks = new Set(taskList.map((task) => task.client_uid))

      // 🌼 Filter the clients to only those with at least one task
      const filteredClientList = clientList.filter((client) => clientsWithTasks.has(client.uid))

      // 🌼 Sort the filtered list by client name
      const sortedClientList = filteredClientList.sort((a, b) => a.name.localeCompare(b.name))

      const clientText = sortedClientList
        .map((client) => `🔹 ${client.name} (/${client.uid})`)
        .join('\n')

      const msg =
        `Please select a 👨‍💼 *client* to filter by:\n\n${clientText}\n\n` +
        `👉 Tap the UID next to the client's name.\n\n` +
        `Note: Only the clients having at least one task have been displayed.`

      return [
        telegramMessage(`Prompting client list for filtering`, msg),
        updateSessionQuery(
          `Prompting user to enter client UID`,
          newStateStack,
          updatedContext,
          false
        ),
      ]
    }

    // 🌼 Case 3: Due Date Filter
    if (selectedFilter === 'due') {
      const today = new Date()
      const ddmmyy = dateToDMY(new Date())
      const weekday = today.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase()

      const msg =
        `📅 Please enter a *due date* to filter by:\n\n` +
        `Format options:\n• DD-MM-YY\n→ like ${ddmmyy}\n\n• Day of week\n→ like ${weekday}\n\n• /today or /tomorrow`

      return [
        telegramMessage(`Prompting for due date filter`, msg),
        updateSessionQuery(
          `Prompting user to enter due date`,
          newStateStack,
          updatedContext,
          false
        ),
      ]
    }

    // 🌸 Case 4: Team Member Filter
    if (selectedFilter === 'member') {
      const members = context.view_tasks?.member_list || []
      const sortedMembers = members.sort((a, b) => a.first_name.localeCompare(b.first_name))
      const memberText = sortedMembers.map((m) => `👤 ${m.first_name} (/${m.uid})`).join('\n')

      const msg =
        `👥 Please select a *team member* to filter by:\n\n${memberText}\n\n` +
        `👉 Tap the UID next to the member's name.`

      return [
        telegramMessage(`Prompting member list for filtering`, msg),
        updateSessionQuery(
          `Prompting user to enter member UID`,
          newStateStack,
          updatedContext,
          false
        ),
      ]
    }

    // 🔺 Case 5: Priority Filter
    if (selectedFilter === 'priority') {
      const msg =
        `🔺 Please choose one of the following *priority* levels:\n\n` +
        `• /low\n• /medium\n• /high\n• /urgent`

      return [
        telegramMessage(`Prompting priority options`, msg),
        updateSessionQuery(`Prompting user for priority`, newStateStack, updatedContext, false),
      ]
    }

    // 📌 Case 6: Status Filter
    if (selectedFilter === 'status') {
      const msg =
        `📌 Please choose a *task status* to filter by:\n\n` +
        `• /pending\n• /review\n• /scrapped\n• /done`

      return [
        telegramMessage(`Prompting task status options`, msg),
        updateSessionQuery(`Prompting user for task status`, newStateStack, updatedContext, false),
      ]
    }
  }

  // 🌸 Flow: Viewing Tasks
  // State: view_tasks_started
  // We will validate the user's filter value and then if all good, proceed. Else ask to re-enter.
  // Next state stack: ..., view_tasks_showTasks
  if (currState === 'view_tasks_validateFilter') {
    const input = String(currInput).trim()
    const selectedFilter = context.view_tasks?.selected_filter
    const clientList = context.view_tasks?.client_list || []
    const memberList = context.view_tasks?.member_list || []

    const newStateStack = replaceTopState(session, 'view_tasks_showTasks')

    // 🌷 If the user selected "all", no validation needed
    if (selectedFilter === 'all') {
      const updatedContext = {
        ...context,
        view_tasks: {
          ...(context.view_tasks || {}),
          filter_value: 'all',
        },
      }

      return [
        updateSessionQuery(
          'User selected /all, skipping filter value validation and proceeding to showTasks',
          newStateStack,
          updatedContext,
          true
        ),
      ]
    }

    // 🌷 Validate based on selected filter
    let isValid = false
    let errorMessage = ''
    const cleanedInput = input.replace('/', '').toLowerCase()

    switch (selectedFilter) {
      case 'client': {
        const clientUIDs = clientList.map((c) => c.uid)
        if (clientUIDs.includes(input.replace('/', '').toUpperCase())) {
          isValid = true
        } else {
          errorMessage = `Hmm, that client UID isn't valid. Please select one from the list above.`
        }
        break
      }

      case 'member': {
        const memberUIDs = memberList.map((m) => m.uid)
        if (memberUIDs.includes(input.replace('/', '').toUpperCase())) {
          isValid = true
        } else {
          errorMessage = `That member UID isn't valid. Please select one from the list above.`
        }
        break
      }

      case 'status': {
        const allowedStatuses = ['pending', 'review', 'done', 'scrapped']
        if (allowedStatuses.includes(cleanedInput)) {
          isValid = true
        } else {
          errorMessage = `Please click a valid status: */pending*, */review*, */done*, or */scrapped*.`
        }
        break
      }

      case 'priority': {
        const allowedPriorities = ['low', 'medium', 'high', 'urgent']
        if (allowedPriorities.includes(cleanedInput)) {
          isValid = true
        } else {
          errorMessage = `Please click a valid priority: */low*, */medium*, */high*, or */urgent*.`
        }
        break
      }

      case 'due': {
        const result = validateDueDate(cleanedInput)
        if (result.valid) {
          isValid = true
        } else {
          errorMessage = `❗ ${result.reason}\nPlease enter a valid due date (e.g., *05-07-25*, *today*, *friday*).`
        }
        break
      }

      default: {
        errorMessage = `Hmm, something went wrong. The filter type wasn't recognized.`
      }
    }

    if (!isValid) {
      return [
        telegramMessage('Invalid filter value entered, asking again.', `🚫 ${errorMessage}`),
        updateSessionQuery(
          'User entered invalid filter value, staying in same state.',
          session,
          context,
          false
        ),
      ]
    }

    // 🌸 All good! Store the filter value and move ahead
    const updatedContext = {
      ...context,
      view_tasks: {
        ...(context.view_tasks || {}),
        filter_value:
          selectedFilter === 'due'
            ? validateDueDate(cleanedInput).parsedDate // 🗓 Store parsed format for due
            : input.replace('/', ''),
      },
    }

    return [
      updateSessionQuery(
        'Filter value validated successfully, moving to showTasks.',
        newStateStack,
        updatedContext,
        true
      ),
    ]
  }

  // TODO Add a state here that outputs the data to the google sheet as well before showing it in telegram

  // 🌸 Flow: Viewing Tasks
  // State: view_tasks_showTasks
  // Filter is good and validated, now we shall filter the
  // tasks and display them using renderTasksView function
  // Next state stack: ..., pop
  if (currState === 'view_tasks_showTasks') {
    const selectedFilter = context.view_tasks.selected_filter
    const filterValue = context.view_tasks.filter_value

    const taskList = Array.isArray(context.view_tasks.task_list) ? context.view_tasks.task_list : []
    const clientList = Array.isArray(context.view_tasks.client_list)
      ? context.view_tasks.client_list
      : []
    const assignmentList = Array.isArray(context.view_tasks.assignment_list)
      ? context.view_tasks.assignment_list
      : []
    const memberList = Array.isArray(context.view_tasks.member_list)
      ? context.view_tasks.member_list
      : []

    // 🌼 Remove scrapped and done
    const activeTasks = taskList.filter(
      ({ status }) => !(status === 'scrapped' || status === 'done')
    )

    // 🌿 Enrich assignments with member names
    const enrichedAssignments = assignmentList.map((a) => ({
      ...a,
      first_name: memberList.find((m) => m.uid === a.member_uid)?.first_name,
    }))

    // 🌷 Determine base task list for filtering
    let baseTasks = selectedFilter === 'status' ? taskList : activeTasks

    // 🌷 Prepare filtered tasks
    let filteredTasks = baseTasks

    switch (selectedFilter) {
      case 'all':
        // no filtering needed
        break

      case 'client':
        filteredTasks = activeTasks.filter((task) => task.client_uid === filterValue)
        break

      case 'due':
        // Convert the filterValue to YYMD format as that is how we store it in the database
        filteredTasks = activeTasks.filter((task) => {
          if (!task.due_date) return false
          return new Date(task.due_date) <= new Date(filterValue)
        })
        break

      case 'member': {
        const assignedTaskUIDs = enrichedAssignments
          .filter((a) => a.member_uid === filterValue)
          .map((a) => a.task_uid)

        filteredTasks = activeTasks.filter((task) => assignedTaskUIDs.includes(task.uid))
        break
      }

      case 'priority':
        filteredTasks = activeTasks.filter((task) => task.priority === filterValue)
        break

      case 'status':
        filteredTasks = activeTasks.filter((task) => task.status === filterValue)
        break
    }

    // If no tasks found for given filter and filter value, inform accordingly and exit
    if (!filteredTasks.length) {
      return [
        telegramMessage(
          `No tasks found for the '${selectedFilter}' filter.`,
          '🌱 No tasks found upon filtering.'
        ),
        updateSessionQuery(
          `No tasks found using '${selectedFilter}' filter.`,
          popState(session),
          `jsonb_strip_nulls(
        jsonb_set(
          COALESCE(context_data, '{}'::jsonb),
          '{view_tasks}',
          'null'::jsonb,
          true
        )
      )`,
          true
        ),
      ]
    }

    // 🌷 Filter clients that have at least one task
    const visibleClientUIDs = new Set(filteredTasks.map((t) => t.client_uid))
    const visibleClients = clientList.filter((c) => visibleClientUIDs.has(c.uid))
    // 🌼 Format task.due_date using cuteDate
    const formattedTasks = filteredTasks.map((task) => ({
      ...task,
      due: task.due_date ? cuteDate(YYMDtoDMY(task.due_date)) : null,
    }))

    // 🌼 Format assignment.due_date using cuteDate
    const formattedAssignments = enrichedAssignments.map((a) => ({
      ...a,
      due: a.due_date ? cuteDate(YYMDtoDMY(a.due_date)) : null,
    }))

    // All dates in tasks and assignments need to be converted to cute dates before sending
    const messageText = renderTasksView({
      clients: visibleClients,
      // tasks: filteredTasks,
      // assignments: enrichedAssignments,
      tasks: formattedTasks,
      assignments: formattedAssignments,
    })

    return [
      telegramMessage(`Displaying tasks with '${selectedFilter}' filter`, messageText),
      updateSessionQuery(
        `Rendered tasks using '${selectedFilter}' filter.`,
        popState(session),
        `jsonb_strip_nulls(
        jsonb_set(
          COALESCE(context_data, '{}'::jsonb),
          '{view_tasks}',
          'null'::jsonb,
          true
        )
      )`,
        true
      ),
    ]
  }

  // 🌸 Flow: Updating a task
  // State: update_task_started
  // User wants to update a task. Fetch all data and store it in update_task
  // Next state stack: ..., update_task_clientSelected, fetch_members, fetch_tasks, fetch_clients, fetch_assignments
  if (currState === 'update_task_started') {
    const newStateStack = pushState(
      pushState(
        pushState(
          pushState(replaceTopState(session, 'update_task_askToSelectClient'), 'fetch_members'),
          'fetch_tasks'
        ),
        'fetch_clients'
      ),
      'fetch_assignments'
    )

    const contextDataSQL = `
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                coalesce(context_data, '{}'::jsonb),
                '{update_task}',
                '{}'::jsonb,
                true
              ),
              '{fetch_assignments}',
              jsonb_build_object('caller', 'update_task'),
              true
            ),
            '{fetch_clients}',
            jsonb_build_object('caller', 'update_task'),
            true
          ),
          '{fetch_tasks}',
          jsonb_build_object('caller', 'update_task'),
          true
        ),
        '{fetch_members}',
        jsonb_build_object('caller', 'update_task'),
        true
      )
    `

    return [
      updateSessionQuery(
        'Updating a task flow started - fetching all data',
        newStateStack,
        contextDataSQL,
        true
      ),
    ]
  }

  // 🌸 Flow: Updating a task
  // State: update_task_askToSelectClient
  // Ask the user to select the client to which the task belongs to
  // Next state: update_task_clientSelected
  if (currState === 'update_task_askToSelectClient') {
    const newStateStack = replaceTopState(session, 'update_task_clientSelected')

    // 🌼 Extract client list and task list from context_data
    const clientList = Array.isArray(context.update_task.client_list)
      ? context.update_task.client_list
      : []

    const taskList = Array.isArray(context.update_task.task_list)
      ? context.update_task.task_list
      : []

    // 🌼 Build a Set of client UIDs who have tasks
    const clientsWithTasks = new Set(
      taskList
        .filter((task) => task.status === 'pending' || task.status === 'review')
        .map((task) => task.client_uid)
    )

    // 🌼 Filter the clients to only those with at least one task
    const filteredClientList = clientList.filter((client) => clientsWithTasks.has(client.uid))

    // 🌼 Sort the filtered list by client name
    const sortedClientList = filteredClientList.sort((a, b) => a.name.localeCompare(b.name))

    const clientText = sortedClientList
      .map((client) => `🔹 ${client.name} (/${client.uid})`)
      .join('\n')

    const message = `🌷 ${currUserName},\n` + `Please select a client:\n\n${clientText}\n\n`

    // TODO Add the below text into /help telegram message
    // `👉 Click on the client's UID displayed next to their name.\n\n` +
    // `Note: Only the clients having at least one active task have been displayed.`

    return [
      telegramMessage(
        `Sending filtered list of clients who have active tasks to user and asking for selection`,
        message
      ),
      updateSessionQuery(`State: update_task_askToSelectClient`, newStateStack, context, false),
    ]
  }

  // 🌸 Flow: Updating a task
  // State: update_task_clientSelected
  // Check the selected client and update context_data
  // Next state: update_task_askToSelectTask
  if (currState === 'update_task_clientSelected') {
    const clientInput = String(currInput).trim().toLowerCase().replace('/', '')

    // Fetch client list and check whether entered client exists in the database
    const clientList = Array.isArray(context.update_task.client_list)
      ? context.update_task.client_list
      : []

    const foundClient = clientList.find(
      (client) => client.uid.toLowerCase() === clientInput.toLowerCase()
    )

    // If invalid client UID was entered, inform the user and show the client list once again
    if (!foundClient) {
      const revertStateStack = replaceTopState(session, 'update_task_askToSelectClient')
      return [
        telegramMessage(
          'Client not found — prompting user to try again',
          `⚠️ Hmm... I couldn't find a client with that UID.\nPlease try again. 🌼`
        ),
        updateSessionQuery(
          `Invalid client input, reverting to update_task_askToSelectClient`,
          revertStateStack,
          context,
          true
        ),
      ]
    }

    // Client UID verified, store the selected client's details and remove client list from
    const newStateStack = replaceTopState(session, 'update_task_askToSelectTask')
    return [
      updateSessionQuery(
        `Client ${foundClient.name} selected — saving in context_data and moving to update_task_askToSelectTask`,
        newStateStack,
        // We remove client_list and add selected_client
        `
          jsonb_strip_nulls(
            jsonb_set(
              jsonb_set(
                context_data,
                '{update_task,client_list}',
                'null'::jsonb,
                true
              ),
              '{update_task,selected_client}',
              jsonb_build_object('uid', '${ess(foundClient.uid)}', 'name', '${ess(foundClient.name)}'),
              true
            )
          )
        `,
        true
      ),
      telegramMessage(
        `tell wonderful after selecting client to make the user feel like a star`,
        `✨ Wonderful!`
      ),
    ]
  }

  // 🌸 Flow: Updating a task
  // State: update_task_askToSelectTask
  // Ask the user to select one of the tasks of the selected client
  // Next state: update_task_taskSelected
  if (currState === 'update_task_askToSelectTask') {
    const newStateStack = replaceTopState(session, 'update_task_taskSelected')

    // 🌼 Extract task list from context_data
    const taskList = Array.isArray(context.update_task.task_list)
      ? context.update_task.task_list
      : []

    // 🌼 Extract selected client UID to filter tasks for that client
    const selectedClientUID = context.update_task.selected_client.uid

    // 🌼 Filter active tasks belonging to selected client
    const filteredTaskList = taskList
      .filter((task) => task.client_uid.toLowerCase() === selectedClientUID.toLowerCase())
      .filter((task) => task.status === 'pending' || task.status === 'review')

    // 🌼 Sort filtered tasks by title
    const sortedTaskList = filteredTaskList.sort((a, b) => a.title.localeCompare(b.title))

    // 🌼 Prepare task display text
    const taskText = sortedTaskList.map((task) => `🔹 ${task.title} (/${task.uid})`).join('\n')

    // 🌼 Prepare message for user
    const message =
      `Please choose the task you wish to assign:\n\n${taskText}\n\n` +
      `👉 Click on the task's UID displayed next to its title.`

    return [
      telegramMessage(`Sending list of tasks to user and asking for selection`, message),
      updateSessionQuery(
        `State: update_task_askToSelectTask. Filtered task list for ` +
          `client UID ${selectedClientUID}. Awaiting user's task selection.`,
        newStateStack,
        context,
        false
      ),
    ]
  }

  // 🌸 Flow: Updating a task
  // State: update_task_taskSelected
  // Check the selected task and update context_data
  // Next state: update_task_askToEnterDetails
  if (currState === 'update_task_taskSelected') {
    // Convert the entered task UID to lowercase and strip '/' symbol for comparison
    const taskInput = String(currInput).trim().toLowerCase().replace('/', '')

    const taskList = Array.isArray(context.update_task.task_list)
      ? context.update_task.task_list
      : []

    // Filter tasks belonging to the selected client
    const filteredTaskList = taskList.filter(
      (task) =>
        task.client_uid.toLowerCase() === context.update_task.selected_client.uid.toLowerCase()
    )

    // Try to find task with matching UID
    const selectedTask = filteredTaskList.find(
      (task) => task.uid.toLowerCase() === taskInput.toLowerCase()
    )

    // If task is not found, ask user to re-enter
    if (!selectedTask) {
      const revertStateStack = replaceTopState(session, `update_task_askToSelectTask`)
      return [
        telegramMessage(
          'Invalid task UID entered',
          `❌ That doesn't seem like a valid task UID.\nPlease click on a task's UID from the list.`
        ),
        updateSessionQuery(
          `Invalid client input, reverting to update_task_askToSelectTask`,
          revertStateStack,
          context,
          true
        ),
      ]
    }

    // Task verified, update context data and proceed
    return [
      updateSessionQuery(
        `Task selected (${selectedTask.uid}). Pushing fetch_members to fetch team list.`,
        replaceTopState(session, 'update_task_askToEnterDetails'),
        `
          jsonb_strip_nulls(
            jsonb_set(
              jsonb_set(
                context_data,
                '{update_task,task_list}',
                'null'::jsonb,
                true
              ),
              '{update_task,selected_task}',
              jsonb_build_object(
                'uid', ${ess(selectedTask.uid)},
                'notes', ${ess(selectedTask.notes)},
                'client_uid', ${ess(selectedTask.client_uid)},
                'title', ${ess(selectedTask.title)},
                'due_date', ${ess(selectedTask.due_date)},
                'created_by', ${ess(selectedTask.created_by)},
                'created_at', ${ess(selectedTask.created_at)},
                'status', ${ess(selectedTask.status)},
                'priority', ${ess(selectedTask.priority)},
              ),
              true
            ),
          )
        `,
        true
      ),
    ]
  }

  // 🌸 Flow: Updating a task
  // State: update_task_askToEnterDetails
  // Show the user the current task card and ask for new details
  // Give quick command to mark task as complete
  // Next state: update_task_validateNewDetails
  if (currState === 'update_task_askToEnterDetails') {
    const newStateStack = replaceTopState(session, 'update_task_validateNewDetails')

    // Prepare Message to send to user - asking to enter task details with an example
    const taskMessage =
      `Click */here* to mark the task as completed.\n\n` +
      `Else, please share the updated task details in *Key:Value* format.\n\n` +
      `For example:\n\n` +
      `*title*: Follow up with vendor\n` +
      `*due*: 22-06-25\n` +
      `*priority*: high\n` +
      `*status*: review\n` +
      `*notes*: Have to follow up with the vendor for photoshoot updates and inform the team\n\n`

    // TODO Make the following into help message info - include valid values for status, priority etc.
    // `The due date can be either in DD-MM-YY format, a day of the week, today, or tomorrow.\n` +
    // `The priority can be low, medium, high, or urgent.\n\n` +
    // `🌼 Only *title* is required — the rest are optional and can be edited anytime.\n\n` +
    // `Take your time. I'm right here when you're ready ✨`

    return [
      telegramMessage(`Asking user for updated task details`, taskMessage),
      updateSessionQuery(`Asking user for updated task details`, newStateStack, context, false),
    ]
  }

  // 🌸 Flow: Updating a task
  // State: update_task_validateNewDetails
  // Validate the new details entered
  // Next state: update_task_updateTable
  if (currState === 'update_task_validateNewDetails') {
    const taskText = String(currInput).trim()

    // If the user wants to just mark the task as done, update context data and proceed
    if (taskText.toLowerCase().replace('/', '') === 'done')
      return [
        updateSessionQuery(
          `update_task_updateTable: Saving updated task details into the table.`,
          replaceTopState(session, 'update_task_updateTable'),
          `jsonb_set(
            context_data,
            '{add_task, update_intention}',
            'mark_as_done'::jsonb),
            true
          )`,
          true
        ),
      ]

    const selectedClient = context.update_task.selected_client

    // 🌿 Parse key:value input using helper function
    const parsedResult = parseKeyValueInput(taskText)

    // If the input is not correct, then inform the user and try again.
    if (!parsedResult.success) {
      const revertStateStack = replaceTopState(session, 'add_task_askForTaskDetails')
      return [
        telegramMessage(parsedResult.info, parsedResult.message),
        updateSessionQuery(parsedResult.info, revertStateStack, context, true),
      ]
    }

    // Test the parsed result for further validation
    const taskData = parsedResult.data
    const validation = validateTaskDetails(taskData)

    if (!validation.valid) {
      const revertStateStack = replaceTopState(session, 'add_task_askForTaskDetails')

      return [
        telegramMessage(validation.info, validation.message),
        updateSessionQuery(validation.info, revertStateStack, context, true),
      ]
    }

    const newStateStack = replaceTopState(session, 'add_task_verifiedTaskDetails')

    // Prepare task with client card to send to user asking to confirm insertion.
    const previewText = renderTasksView({
      clients: [{ uid: selectedClient.uid, name: selectedClient.name }],
      tasks: [
        {
          client_uid: selectedClient.uid,
          title: taskData.title,
          priority: taskData.priority ? `${taskData.priority}` : '',
          due: validation.dueDate ? `${cuteDate(validation.dueDate)}` : '',
        },
      ],
      assignments: [],
    })

    // 🌸 Add confirmation instructions
    const confirmMessage =
      previewText +
      `\n\n👥 —\n\n` +
      `If this looks good,\n✅ Click */yes* to confirm, or\n` +
      `🚫 Click */no* to enter task details again.`

    return [
      telegramMessage(
        'Confirming task details with user (yes/no) in formatted client card style',
        confirmMessage
      ),
      updateSessionQuery(
        `add_task_receivedTaskDetails: Saving task details into context_data. ` +
          `Asking user if task is okay to be entered, and proceeding to updage_task_verifiedDetails`,
        newStateStack,
        `jsonb_set(
          context_data,
          '{add_task, task_details}',
          to_jsonb('${JSON.stringify(taskData)}'::json),
          true
        )`,
        false
      ),
    ]
  }

  // 🌸 Flow: Updating a task
  // State: update_task_updateTable
  // Update the table in the database
  // Next state: update_task_taskUpdated
  if (currState === 'update_task_updateTaskDetails') {
    // TODO
  }

  // 🌸 Flow: Updating a task
  // State: update_task_taskUpdated
  // Inform the user that the task has been updated
  // Show the new task card and pop
  // Pop state
  if (currState === 'update_task_taskUpdated') {
    // TODO
  }

  // 🌸 Flow: Updating an assignment
  // State: update_assignment_started
  // User wants to update an assignment. Fetch all data and store it in update_assignment
  // Next state stack: ..., update_assignment_dataFetched, fetch_members, fetch_tasks, fetch_clients, fetch_assignments
  if (currState === 'update_assignment_started') {
    // TODO
  }

  // 🌸 Flow: Updating an assignment
  // State: update_assignment_dataFetched
  // Data fetched, go to next state
  // Next state: update_assignment_askToSelectClient
  if (currState === 'update_assignment_dataFetched') {
    // TODO
  }

  // 🌸 Flow: Updating an assignment
  // State: update_assignment_askToSelectClient
  // Ask to select client to whom the assignment's task belongs to
  // Next state: update_assignment_clientSelected
  if (currState === 'update_assignment_askToSelectClient') {
    // TODO
  }

  // 🌸 Flow: Updating an assignment
  // State: update_assignment_clientSelected
  // Validate selected client
  // Next state: update_assignment_askToSelectTask
  if (currState === 'update_assignment_clientSelected') {
    // TODO
  }

  // 🌸 Flow: Updating an assignment
  // State: update_assignment_askToSelectTask
  // Ask to select the task that the assignment belongs to
  // Next state: update_assignment_taskSelected
  if (currState === 'update_assignment_askToSelectTask') {
    // TODO
  }

  // 🌸 Flow: Updating an assignment
  // State: update_assignment_taskSelected
  // Validate selected task
  // Next state: update_assignment_askToSelectAssignment
  if (currState === 'update_assignment_taskSelected') {
    // TODO
  }

  // 🌸 Flow: Updating an assignment
  // State: update_assignment_askToSelectAssignment
  // Ask to select assignment to be updated
  // Next state: update_assignment_assignmentSelected
  if (currState === 'update_assignment_askToSelectAssignment') {
    // TODO
  }

  // 🌸 Flow: Updating an assignment
  // State: update_assignment_assignmentSelected
  // Validated selected assignment
  // Next state: update_assignment_askToEnterDetails
  if (currState === 'update_assignment_assignmentSelected') {
    // TODO
  }

  // 🌸 Flow: Updating an assignment
  // State: update_assignment_askToEnterDetails
  // Ask to enter new assignment details, quick option for mark it as completed
  // Next state: update_assignment_validateNewDetails
  if (currState === 'update_assignment_askToEnterDetails') {
    // TODO
  }

  // 🌸 Flow: Updating an assignment
  // State: update_assignment_validateNewDetails
  // Validate new details
  // Next state: update_assignment_updateAssignmentDetails
  if (currState === 'update_assignment_validateNewDetails') {
    // TODO
  }

  // 🌸 Flow: Updating an assignment
  // State: update_assignment_updateAssignmentDetails
  // Enter new assignment details into the database
  // Next state: update_assignment_assignmentUpdated
  if (currState === 'update_assignment_updateAssignmentDetails') {
    // TODO
  }

  // 🌸 Flow: Updating an assignment
  // State: update_assignment_assignmentUpdated
  // Inform user, show new card and exit
  // Next state: pop
  if (currState === 'update_assignment_assignmentUpdated') {
    // TODO
  }

  // 🌸 Flow: Asking what user wants to do when selected other
  // State: other_started
  // Present all options to user and ask what they would like to do
  if (currState === 'other_started') {
    const newStateStack = replaceTopState(session, 'check_other_command')

    const message =
      `🌻 ${currUserName},\nPlease enter a command from the list below:\n\n` +
      `👥 Clients\n` +
      `/addC\nAdd a new client\n` +
      `deleteC\nDelete an existing client\n` +
      `viewC\nView all clients\n` +
      `\n\n📋 Tasks\n` +
      `deleteT\nDelete an existing task\n` +
      `\n\n👤 Members\n` +
      `/addM\nAdd a new team member\n` +
      `/updateM\nUpdate an existing team member's details\n` +
      `/deleteM\nDelete an existing team member\n` +
      `/viewM\nView all team members\n` +
      `\n\n🗃 Miscellaneous\n` +
      `sendT\nSend a team member's tasks to them\n` +
      `backT\nBack up all the current task list data\n` +
      `/changePass\nChange your RI Task Bot Account Password\n` +
      `/logout\nLog out of your RI Task Bot Account`

    return [
      telegramMessage('Present list of other commands to user', message),
      updateSessionQuery(
        `State changes from other_started to check_other_command. We check what "other" command the user enters.`,
        newStateStack,
        context,
        false,
        currUserTelegramID
      ),
    ]
  }

  // 🌸 Flow: Parsing user's input about other command
  // State: check_other_command
  // Check user's input for other command
  if (currState === 'check_other_command') {
    const nextState = getOtherCommandNextState(currInput)

    if (nextState === 'invalid') {
      return [
        telegramMessage(
          `Invalid command entered in Other section`,
          `❌ Oops, I couldn't understand that command.\n🌸 Please enter a valid command.`
        ),
        updateSessionQuery(
          'Reverting back to other_started because of invalid command',
          session,
          context,
          false,
          currUserTelegramID
        ),
      ]
    } else {
      const newStateStack = replaceTopState(session, nextState)
      return [
        updateSessionQuery(
          `Updating state to push ${nextState} on top of session_ongoing`,
          newStateStack,
          context,
          true,
          currUserTelegramID
        ),
      ]
    }
  }

  // 🌸 Flow: Adding a new client
  // State: add_client_started
  // Ask user for new client's name
  if (currState === 'add_client_started') {
    const newStateStack = pushState(
      replaceTopState(session, 'add_client_receivedClientName'),
      'fetch_clients'
    )
    return [
      telegramMessage(`asking user the client's name`, `Please enter the new client's name ☺`),
      updateSessionQuery(
        `Fetching clients for adding task by pushing fetch_clients on stack`,
        newStateStack,
        `
          jsonb_set(
            jsonb_set(
              COALESCE(context_data, '{}'::jsonb),
              '{add_client}',
              COALESCE(context_data->'add_client', '{}'::jsonb),
              true
            ),
            '{fetch_clients}',
            jsonb_set(
              COALESCE(context_data->'fetch_clients', '{}'::jsonb),
              '{caller}',
              '"add_client"'::jsonb,
              true
            ),
            true
          )
        `,
        false
      ),
    ]
  }

  // 🌸 Flow: Add a new Client
  // State: add_client_receivedClientName
  // Once the user has entered a name, check for exact duplicates (case + whitespace insensitive)
  // Next state (if valid): add_client_verifiedClientName
  if (currState === 'add_client_receivedClientName') {
    const rawInput = String(currInput)
    const newClientName = rawInput.trim().toLowerCase()

    const clientList = Array.isArray(context.add_client?.client_list)
      ? context.add_client.client_list
      : []

    const duplicateClient = clientList.find((client) => {
      return client.name?.trim().toLowerCase() === newClientName
    })

    if (duplicateClient) {
      const message =
        `⚠️ A client named *"${duplicateClient.name}"* already exists.\n\n` +
        `🌸 Please enter a *unique client name*.`

      return [telegramMessage(`Duplicate client name detected`, message)]
    }

    // 🌱 If name is valid and unique, proceed to next state
    const newStateStack = replaceTopState(session, 'add_client_verifiedClientName')

    return [
      updateSessionQuery(
        `Client name is valid and unique. Moving to add_client_verifiedClientName`,
        newStateStack,
        `jsonb_set(
          COALESCE(context_data, '{}'::jsonb),
          '{add_client,new_client_name}',
          to_jsonb('${rawInput.trim()}'::text),
          true
        )`,
        true
      ),
    ]
  }

  // 🌸 Flow: Add a new Client
  // State: add_client_verifiedClientName
  // Proceed with generating unique ID and enter it into the database
  if (currState === 'add_client_verifiedClientName') {
    const clientList = Array.isArray(context.add_client.client_list)
      ? context.add_client.client_list
      : []

    // 🌷 Retrieve name of new client from context
    const newClientName = context.add_client.new_client_name?.trim()
    const uidList = clientList.map((c) => c.uid)

    // 🌿 Generate UID
    const clientUID = generateUID('C', uidList)
    const newStateStack = replaceTopState(session, 'add_client_clientAdded')

    return [
      {
        json: {
          route: 'postgresNode',
          info: 'Inserting new client into DB table clients',
          query: `
          INSERT INTO clients (uid, name)
          VALUES ('${clientUID}', '${newClientName}');
        `.trim(),
        },
      },
      updateSessionQuery(
        `Inserted new client ${newClientName}. Now proceeding to add_client_clientAdded`,
        newStateStack,
        `jsonb_set(
        COALESCE(context_data, '{}'::jsonb),
        '{add_client,new_client_uid}',
        to_jsonb('${clientUID}'::text),
        true
      )`,
        true
      ),
    ]
  }

  // 🌸 Flow: Add a new Client
  // State: add_client_clientAdded
  // New client is added, now check if it was called, and if yes, proceed accordingly, inform the user and pop
  if (currState === 'add_client_clientAdded') {
    const newClientUID = context.add_client?.new_client_uid
    const newClientName = context.add_client?.new_client_name
    const caller = context.add_client?.caller || null

    const newStateStack = popState(session)

    const extraQuery =
      caller === 'add_task'
        ? `jsonb_strip_nulls(
            jsonb_set(
              jsonb_set(
                COALESCE(context_data, '{}'::jsonb),
                '{add_task,selected_client}',
                jsonb_build_object('uid', '${newClientUID}', 'name', '${newClientName}'),
                true
              ),
              '{add_client}',
              'null'::jsonb,
              true
            )
          )`
        : `jsonb_strip_nulls(
            jsonb_set(
              COALESCE(context_data, '{}'::jsonb),
              '{add_client}',
              'null'::jsonb,
              true
            )
          )`
    return [
      telegramMessage(
        'Informing user that new client has been added',
        `✅ Client *${newClientName}* has been added successfully!\n` +
          (caller === 'add_task' ? `🌼 Now continuing with adding your new task.` : ``)
      ),
      updateSessionQuery(
        `Client added. Context updated. Caller: ${caller || 'none'}`,
        newStateStack,
        extraQuery,
        true
      ),
    ]
  }

  // 🌸 Flow: Add a new Member
  // State: add_member_started
  // Starting to add new member. Fetch all current members' details for reference.
  // Next state stack: ..., add_member_askForDetails, fetch_members
  if (currState === 'add_member_started') {
    const newStateStack = pushState(
      replaceTopState(session, 'add_member_askForDetails'),
      'fetch_members'
    )

    const contextDataSQL = `
      jsonb_set(
        jsonb_set(
          coalesce(context_data, '{}'::jsonb),
          '{add_member}',
          '{}'::jsonb,
          true
        ),
        '{fetch_members}',
        jsonb_build_object('caller', 'add_member'),
        true
      )`

    return [
      updateSessionQuery(
        'Adding new member - fetching details',
        newStateStack,
        contextDataSQL,
        true,
        currUserTelegramID
      ),
    ]
  }

  // 🌸 Flow: Add a new Member
  // State: add_member_askForDetails
  // Ask the user for all the relevant details of the new team member
  // Next state: add_member_checkDetails
  if (currState === 'add_member_askForDetails') {
    const newStateStack = replaceTopState(session, 'add_member_checkDetails')

    const Message =
      `Please share the details of the new team member in *Key:Value* format.\n\nFor example:\n\n` +
      `*first_name*: Erika\n` +
      `*role*: employee\n` +
      `*email_id*: erika1234@gmail.com\n\n` +
      `The role can be either *boss* or *employee*\n` +
      `*email_id* is optional`

    return [
      telegramMessage(`Asking user for new member details`, Message),
      updateSessionQuery(
        `User will enter new member's details now.`,
        newStateStack,
        context,
        false,
        currUserTelegramID
      ),
    ]
  }

  // 🌸 Flow: Add a new Member
  // State: add_member_checkDetails
  // Check all entered details and validate the input
  // Next state: add_member_addToDB
  if (currState === 'add_member_checkDetails') {
    const memberText = String(currInput).trim()
    const parsed = parseKeyValueInput(memberText)

    if (!parsed.success) {
      const newStateStack = replaceTopState(session, 'add_member_askForDetails')
      return [
        telegramMessage('User entered no colons in add_member_checkDetails', parsed.message),
        updateSessionQuery(parsed.info, newStateStack, context, true, currUserTelegramID),
      ]
    }

    const data = parsed.data

    // Begin validation
    const allowedKeys = ['first_name', 'role', 'email_id']
    const invalidKeys = Object.keys(data).filter((k) => !allowedKeys.includes(k))

    if (invalidKeys.length > 0) {
      const newStateStack = replaceTopState(session, 'add_member_askForDetails')
      return [
        telegramMessage(
          'User entered unknown fields for member',
          `Unknown field(s): *${invalidKeys.join(', ')}*.\n\nPlease use only:\n*first_name*, *role*, and *email_id*.`
        ),
        updateSessionQuery(
          'Invalid keys entered while adding member',
          newStateStack,
          context,
          true,
          currUserTelegramID
        ),
      ]
    }

    // Validate first_name
    const firstName = data.first_name
    if (!firstName || !/^[a-zA-Z]+$/.test(firstName)) {
      const newStateStack = replaceTopState(session, 'add_member_askForDetails')
      return [
        telegramMessage(
          'Invalid first_name for new member',
          `The *first_name* must be a single word and only contain letters (A-Z).` +
            `\n\nYou entered: *${firstName || 'nothing'}*.\nPlease try again.`
        ),
        updateSessionQuery(
          'Invalid first_name entered while adding member',
          newStateStack,
          context,
          true,
          currUserTelegramID
        ),
      ]
    }

    // Validate role if present
    const role = data.role.toLowerCase()
    if (!role || (role !== 'boss' && role !== 'employee')) {
      const newStateStack = replaceTopState(session, 'add_member_askForDetails')
      return [
        telegramMessage(
          'Invalid role for new member',
          `The *role* must be either *boss* or *employee*.\n\nYou entered: *${role}*.\nPlease try again.`
        ),
        updateSessionQuery(
          'Invalid role entered while adding member',
          newStateStack,
          context,
          true,
          currUserTelegramID
        ),
      ]
    }

    // Validate email_id if present
    const email = data.email_id
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const newStateStack = replaceTopState(session, 'add_member_askForDetails')
      return [
        telegramMessage(
          'Invalid email_id for new member',
          `The *email_id* you entered is not a valid email.\n\nYou entered: *${email}*\nPlease try again.`
        ),
        updateSessionQuery(
          'Invalid email_id entered while adding member',
          newStateStack,
          context,
          true,
          currUserTelegramID
        ),
      ]
    }

    const contextDataSQL = `
      jsonb_set(
        coalesce(context_data, '{}'::jsonb),
        '{add_member,new_member_details}',
        jsonb_build_object(
          'first_name', '${firstName}',
          'role', ${role ? `'${role}'` : 'null'},
          'email_id', ${email ? `'${email}'` : 'null'}
        ),
        true
      )
    `
    const newStateStack = replaceTopState(session, 'add_member_addToDB')

    return [
      updateSessionQuery(
        'Moving to add_member_addToDB with valid member details',
        newStateStack,
        contextDataSQL,
        true,
        currUserTelegramID
      ),
    ]
  }

  // 🌸 Flow: Add a new Member
  // State: add_member_addToDB
  // Add the new member to the database
  // Next state: pop
  if (currState === 'add_member_addToDB') {
    const memberDetails = context.add_member?.new_member_details

    if (!memberDetails || !memberDetails.first_name || !memberDetails.role) {
      return [
        telegramMessage(
          'Missing member details while trying to insert into DB',
          `Something went wrong. Please re-enter the member details.`
        ),
        updateSessionQuery(
          'Missing member details in add_member_addToDB',
          replaceTopState(session, 'add_member_askForDetails'),
          context,
          true,
          currUserTelegramID
        ),
      ]
    }

    const passwordPrefix = memberDetails.role === 'boss' ? 'owl' : 'bunny'
    const password = passwordPrefix + memberDetails.first_name.toLowerCase()

    const memberUIDList = (context.add_member?.member_list || []).map((m) => m.uid)
    const memberUID = generateUID('M', memberUIDList)

    const newStateStack = popState(session)

    const firstName = memberDetails.first_name
    const role = memberDetails.role
    const email = memberDetails.email_id || null

    const fields = {
      uid: memberUID,
      first_name: firstName,
      role,
      email_id: email,
      password,
    }

    // Escape single quotes for safety
    const escape = (val) => (val ? val.replace(/'/g, `''`) : null)

    return [
      {
        json: {
          route: 'postgresNode',
          info: 'Inserting new member into DB table team_members',
          query: `
          INSERT INTO team_members (email_id, password, uid, first_name, role)
          VALUES (
            ${fields.email_id ? `'${escape(fields.email_id)}'` : 'NULL'},
            '${escape(fields.password)}',
            '${escape(fields.uid)}',
            '${escape(fields.first_name)}',
            '${escape(fields.role)}'
          );
        `.trim(),
        },
      },
      telegramMessage(
        'Informing addition of new team member',
        `✅ *New Team Member added successfully!*\n\n` +
          `• 👤 *Name*: ${firstName}\n` +
          `• 🆔 *UID*: ${memberUID}\n` +
          `• 🔐 *Password*: ${password}\n\n` +
          `Please share the details with the member.`
      ),
      updateSessionQuery(
        'New member added to DB. Cleaning up context.',
        newStateStack,
        `
        jsonb_strip_nulls(
          jsonb_set(
            coalesce(context_data, '{}'::jsonb),
            '{add_member}',
            'null'::jsonb,
            true
          )
        )
      `,
        true,
        currUserTelegramID
      ),
    ]
  }

  // 🌸 Flow: Delete a Member
  // State: delete_member_started
  // Fetch all the assignments and members details
  // Next state stack: ..., delete_member_selectMember, fetch_assignments, fetch_members
  if (currState === 'delete_member_started') {
    const newStateStack = pushState(
      pushState(replaceTopState(session, 'delete_member_selectMember'), 'fetch_assignments'),
      'fetch_members'
    )

    const contextDataSQL = `
      jsonb_set(
        jsonb_set(
          jsonb_set(
            coalesce(context_data, '{}'::jsonb),
            '{delete_member}',
            '{}'::jsonb,
            true
          ),
          '{fetch_assignments}',
          jsonb_build_object('caller', 'delete_member'),
          true
        ),
        '{fetch_members}',
        jsonb_build_object('caller', 'delete_member'),
        true
      )`

    return [
      updateSessionQuery(
        'Deleting team member - fetching assignment and member details',
        newStateStack,
        contextDataSQL,
        true,
        currUserTelegramID
      ),
    ]
  }

  // 🌸 Flow: Delete a Member
  // State: delete_member_selectMember
  // Show the list of employees and ask whom to delete
  // Next state: delete_member_confirmDeletion
  if (currState === 'delete_member_selectMember') {
    const members = context.delete_member?.member_list || []
    const assignments = context.delete_member?.assignment_list || []

    const activeStatuses = new Set(['pending', 'review'])

    // Build active assignment count per member UID
    const assignmentCountMap = {}
    for (const a of assignments) {
      if (activeStatuses.has(a.status) && a.member_uid) {
        assignmentCountMap[a.member_uid] = (assignmentCountMap[a.member_uid] || 0) + 1
      }
    }

    // Filter out bosses, and build enriched member list with count
    const deletableMembers = members
      .filter((m) => m.role === 'employee')
      .map((m) => ({
        ...m,
        activeCount: assignmentCountMap[m.uid] || 0,
      }))
      .sort((a, b) => a.first_name.localeCompare(b.first_name)) // Sort by name

    if (deletableMembers.length === 0) {
      return [
        telegramMessage(
          'No deletable members found',
          `There are no deletable team members at the moment.`
        ),
        updateSessionQuery(
          'No deletable team members available',
          popState(session),
          `jsonb_strip_nulls(
            jsonb_set(
              coalesce(context_data, '{}'::jsonb),
              '{delete_member}',
              'null'::jsonb,
              true
            )
          )`,
          true,
          currUserTelegramID
        ),
      ]
    }

    // Prepare message
    const displayLines = deletableMembers.map(
      (m) => `• 👤 *${m.first_name}* (/${m.uid}) — 🧮 *${m.activeCount}* active assignments`
    )

    const displayMessage =
      displayLines.join('\n') + `\n\nPlease click the *UID* of the member you wish to delete.`

    const newStateStack = replaceTopState(session, 'delete_member_confirmDeletion')

    return [
      telegramMessage('Showing deletable members list', displayMessage),
      updateSessionQuery(
        'Waiting for UID input to confirm deletion',
        newStateStack,
        context,
        false,
        currUserTelegramID
      ),
    ]
  }

  // 🌸 Flow: Delete a Member
  // State: delete_member_confirmDeletion
  // Ask for confirmation and tell about active tasks
  // Next state: delete_member_performDeletion
  if (currState === 'delete_member_confirmDeletion') {
    const userInput = String(currInput).trim().toLowerCase().replace('/', '')
    const members = context.delete_member?.member_list || []

    const selectedMember = members.find((m) => m.uid.toLowerCase() === userInput)

    if (!selectedMember) {
      return [
        telegramMessage(
          'Invalid UID',
          `🚫 I couldn't find a team member with UID *${userInput}*.` +
            `\nPlease try again by clicking a valid UID from the list.`
        ),
      ]
    }

    const warningMessage =
      `⚠️ *Warning*\n\nAll active assignments of ${capitalize(selectedMember.first_name)} ` +
      `will be marked as *scrapped* upon deletion.\n\nAre you sure you want to` +
      ` delete this member?\n✅ Click */yes* to confirm, or ❌ */no* to cancel.`

    const contextDataSQL = `
    jsonb_set(
      coalesce(context_data, '{}'::jsonb),
      '{delete_member, selected_member_uid}',
      to_jsonb('${selectedMember.uid}'),
      true
    )
  `.trim()

    const newStateStack = replaceTopState(session, 'delete_member_performDeletion')

    return [
      telegramMessage('Confirming deletion of team member', warningMessage),
      updateSessionQuery(
        'Stored selected member UID and moved to confirmation state',
        newStateStack,
        contextDataSQL,
        false,
        currUserTelegramID
      ),
    ]
  }

  // 🌸 Flow: Delete a Member
  // State: delete_member_performDeletion
  // Delete the member from the database and mark all their assignments as scrapped
  // Inform the user and pop
  if (currState === 'delete_member_performDeletion') {
    const selectedUID = context.delete_member?.selected_member_uid

    if (!selectedUID) {
      return [
        telegramMessage(
          'Missing UID',
          `❌ Couldn't find which member to delete. Please restart the flow.`
        ),
        updateSessionQuery(
          'Error: UID missing during deletion',
          popState(session),
          `jsonb_strip_nulls(
          jsonb_set(coalesce(context_data, '{}'::jsonb), '{delete_member}', 'null'::jsonb, true)
        )`,
          true,
          currUserTelegramID
        ),
      ]
    }

    const newStateStack = popState(session)

    const SQL1 = `
    -- 1. Scrap all active assignments of the member
    UPDATE task_assignments
    SET status = 'scrapped', member_uid = NULL
    WHERE member_uid = '${selectedUID}'
    AND status IN ('pending', 'review');`.trim()

    const SQL2 = `
    -- 2. Delete the member from team_members
    DELETE FROM team_members
    WHERE uid = '${selectedUID}';`.trim()

    const SQL3 = `
   -- 3. Mark sessions that may belong to this user as logged_out
    UPDATE track_session
    SET state = '["logged_out"]'::jsonb,
        context_data = '{}'::jsonb
    WHERE muid = '${selectedUID}';`.trim()

    return [
      {
        json: {
          route: 'postgresNode',
          info: `Marking deleted member's assignments as scrapped`,
          query: SQL1,
        },
      },
      {
        json: {
          route: 'postgresNode',
          info: 'Deleting member from team_members table',
          query: SQL2,
        },
      },
      {
        json: {
          route: 'postgresNode',
          info: `Logging out all users logged in to deleted member's account`,
          query: SQL3,
        },
      },
      telegramMessage(
        'Member Deleted',
        `🗑️ Member with UID *${selectedUID}* has been deleted successfully.` +
          `\nAll their active assignments were marked as *scrapped*.`
      ),
      updateSessionQuery(
        'Resetting state after deletion',
        newStateStack,
        `jsonb_strip_nulls(
        jsonb_set(
          coalesce(context_data, '{}'::jsonb),
          '{delete_member}',
          'null'::jsonb,
          true
        )
      )`,
        true,
        currUserTelegramID
      ),
    ]
  }

  // 🌸 Flow: Update a Member's Details
  // State: update_member_started
  // Fetch all the members details
  // Next state: update_member_selectMember
  if (currState === 'update_member_started') {
    // TODO
  }

  // 🌸 Flow: Update a Member's Details
  // State: update_member_selectMember
  // Show all the members and ask the user to select one
  // Next state: update_member_askForDetails
  if (currState === 'update_member_selectMember') {
    // TODO
  }

  // 🌸 Flow: Update a Member's Details
  // State: update_member_askForDetails
  // Ask the user for the new details
  // Next state: update_member_checkDetails
  if (currState === 'update_member_askForDetails') {
    // TODO
  }

  // 🌸 Flow: Update a Member's Details
  // State: update_member_checkDetails
  // Ask the user for the new details
  // Next state: update_member_updateDB
  if (currState === 'update_member_checkDetails') {
    // TODO
  }

  // 🌸 Flow: Update a Member's Details
  // State: update_member_updateDB
  // Ask the user for the new details
  // Next state: update_member_updatedMember
  if (currState === 'update_member_updateDB') {
    // TODO
  }

  // 🌸 Flow: Update a Member's Details
  // State: update_member_updatedMember
  // Inform the user and pop
  if (currState === 'update_member_updatedMember') {
    // TODO
  }

  // 🌸 Flow: View All Members
  // State: view_members_started
  // Fetch all the details from the database
  // Next state stack: ..., view_members_showDetails, fetch_assignments, fetch_members
  if (currState === 'view_members_started') {
    // TODO
  }

  // 🌸 Flow: View All Members
  // State: view_members_showDetails
  // Show all the member's details as well as number of active assignments, and pop
  if (currState === 'view_members_showDetails') {
    // TODO
  }

  // 🌸 Flow: Change Password
  // State: change_password_started
  // Fetch all the members details
  // Next state stack: ..., change_password_askOldPassword, fetch_members
  if (currState === 'change_password_started') {
    // TODO
  }

  // 🌸 Flow: Change Password
  // State: change_password_askOldPassword
  // Ask the user for their old password for security. Skip if role is boss.
  // Next state: change_password_checkOldPassword
  if (currState === 'change_password_askOldPassword') {
    // TODO
  }

  // 🌸 Flow: Change Password
  // State: change_password_checkOldPassword
  // Check if entered old password is correct
  // Next state: change_password_askNewPassword
  if (currState === 'change_password_checkOldPassword') {
    // TODO
  }

  // 🌸 Flow: Change Password
  // State: change_password_askNewPassword
  // Ask the user for the new password
  // Next state: change_password_updateDB
  if (currState === 'change_password_askNewPassword') {
    // TODO
  }

  // 🌸 Flow: Change Password
  // State: change_password_updateDB
  // Update the password in the database
  // Next state: change_password_passwordChanged
  if (currState === 'change_password_updateDB') {
    // TODO
  }

  // 🌸 Flow: Change Password
  // State: change_password_passwordChanged
  // Inform the user and pop
  if (currState === 'change_password_passwordChanged') {
    // TODO
  }

  // 🌸 Flow: Last Intention Ended
  // State: session_ongoing
  // Ask the user if they would like to do anything else
  if (currState === 'session_ongoing') {
    const newStateStack = replaceTopState(session, 'another_session_input')
    return [
      telegramMessage(
        'last session ended so asking for further actions',
        `🌟 Would you like to do anything else?\n\n` +
          `🌱 Click /yes to confirm.\n` +
          `🚪 Click /no to exit.`
      ),
      updateSessionQuery(
        `Proceed to next node that checks the user's reply, to do something else or end.`,
        newStateStack,
        context,
        false
      ),
    ]
  }

  // 🌸 Flow: Ask user if they want to perform another action
  // State: another_session_input
  if (currState === 'another_session_input') {
    const clientInput = String(currInput).trim().toLowerCase().replace('/', '')
    if (clientInput === 'no') {
      const newStateStack = replaceTopState(session, 'session_ended')
      return [
        updateSessionQuery('User chose to end session', newStateStack, `'{}'::jsonb`, false),
        telegramMessage(
          'User chose to end session',
          '🙏 Thank you for using RI Task List Bot.\nThe session has now ended.'
        ),
      ]
    } else if (clientInput === 'yes') {
      const newStateStack = replaceTopState(session, 'new_session')

      return [
        updateSessionQuery(
          'User chose to perform another action.',
          newStateStack,
          `'{}'::jsonb`,
          true
        ),
      ]
    }

    // If the user replies with anything other than "yes" or "no", tell them to enter again.
    else
      return [
        telegramMessage(
          'User gave invalid input when asked if they want to do something else',
          'Please only reply with either */yes* to continue or */no* to exit. 😃'
        ),
        updateSessionQuery('User chose to perform another action.', session, context, false),
      ]
  }

  // 🌸 Flow: Start a new session since last one ended
  // State: session_ended
  if (currState === 'session_ended') {
    const newStateStack = replaceTopState(session, 'new_session')
    return [
      updateSessionQuery(
        'Starting new session from session_ended',
        newStateStack,
        `'{}'::jsonb`,
        true
      ),
    ]
  }

  // 🌸 Flow: Login/Logout
  // State:

  // 🌸 Subflow: fetching all clients details from the database
  // State: fetch_clients
  // Pop the stack after this is complete
  if (currState === 'fetch_clients') {
    const newStateStack = popState(session)
    const caller = context.fetch_clients.caller

    // The jsonb strip nulls removes keys with null values, and COALESCE handles null returns
    return [
      updateSessionQuery(
        `Fetching clients for ${caller} by retrieving the data and placing in context_data, then cleaning fetch_clients`,
        newStateStack,
        `
        jsonb_strip_nulls(
          jsonb_set(
            jsonb_set(
              COALESCE(context_data, '{}'::jsonb),
              '{${caller},client_list}',
              COALESCE(
                to_jsonb(
                  (SELECT json_agg(json_build_object('uid', uid, 'name', name)) FROM clients)
                ),
                '[]'::jsonb
              ),
              true
            ),
            '{fetch_clients}',
            'null'::jsonb,
            true
          )
        )
        `,
        true
      ),
    ]
  }

  // 🌸 Subflow: fetching all tasks details from the database
  // State: fetch_tasks
  // Pop the stack after this is complete
  if (currState === 'fetch_tasks') {
    const newStateStack = popState(session)

    const caller = context.fetch_tasks.caller
    return [
      updateSessionQuery(
        `fetch_tasks: Fetching tasks and placing in context_data for caller '${caller}', then cleaning fetch_tasks`,
        newStateStack,
        `
        jsonb_strip_nulls(
          jsonb_set(
            jsonb_set(
              COALESCE(context_data, '{}'::jsonb),
              '{${caller},task_list}',
              COALESCE(
                to_jsonb(
                  (
                    SELECT json_agg(
                      json_build_object(
                        'uid', uid,
                        'title', title,
                        'client_uid', client_uid,
                        'priority', priority,
                        'due_date', due_date,
                        'created_by', created_by,
                        'status', status,
                        'created_at', created_at,
                        'notes', notes
                      )
                    )
                    FROM tasks
                  )
                ),
                '[]'::jsonb
              ),
              true
            ),
            '{fetch_tasks}',
            'null'::jsonb,
            true
          )
        )
        `,
        true
      ),
    ]
  }

  // 🌸 Subflow: fetching all members details from the database for the specific caller
  // State: fetch_members
  // Pop the stack after this is complete
  if (currState === 'fetch_members') {
    const newStateStack = popState(session)
    const caller = context.fetch_members.caller

    return [
      updateSessionQuery(
        `fetch_members: Fetching members and placing in context_data for caller '${caller}', then cleaning fetch_members`,
        newStateStack,
        `
        jsonb_strip_nulls(
          jsonb_set(
            jsonb_set(
              COALESCE(context_data, '{}'::jsonb),
              '{${caller},member_list}',
              COALESCE(
                to_jsonb(
                  (
                    SELECT json_agg(
                      json_build_object(
                        'uid', uid,
                        'first_name', first_name,
                        'password', password,
                        'role', role,
                        'email_id', email_id
                      )
                    )
                    FROM team_members
                  )
                ),
                '[]'::jsonb
              ),
              true
            ),
            '{fetch_members}',
            'null'::jsonb,
            true
          )
        )
        `,
        true,
        currUserTelegramID
      ),
    ]
  }

  // 🌸 Subflow: fetching all assignment details from the database
  // State: fetch_assignments
  // Pop the stack after this is complete
  if (currState === 'fetch_assignments') {
    const caller = context.fetch_assignments?.caller

    return [
      updateSessionQuery(
        `fetch_assignments: for caller '${caller}', then cleaning fetch_assignments`,
        popState(session),
        `
        jsonb_strip_nulls(
          jsonb_set(
            jsonb_set(
              COALESCE(context_data, '{}'::jsonb),
              '{${caller},assignment_list}',
              COALESCE(
                to_jsonb(
                  (
                    SELECT json_agg(
                      json_build_object(
                        'task_uid', task_uid,
                        'member_uid', member_uid,
                        'resp', resp,
                        'uid', uid,
                        'status', status,
                        'assigned_by', assigned_by,
                        'assigned_at', assigned_at,
                      )
                    )
                    FROM task_assignments
                  )
                ),
                '[]'::jsonb
              ),
              true
            ),
            '{fetch_assignments}',
            'null'::jsonb,
            true
          )
        )
        `,
        true
      ),
    ]
  }

  // Flow: Logging out
  // Occurs when the user selects log out command from the Other menu
  if (currState === 'log_out') {
    return [
      telegramMessage(
        'Logged out',
        `You've been successfully logged out. Send a message to begin again.`
      ),
      {
        json: {
          route: 'updateSession',
          info: 'Update session to reflect logged-in user',
          query: `
            UPDATE track_session
            SET 
              muid = NULL,
              state = '["logged_out"]'::jsonb,
              context_data = '{}'::jsonb,
              processing_flag = false,
              last_updated = NOW()
            WHERE telegram_id = '${currUserTelegramID}';
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
    '✏️ Update Task': 'update_task_started',
    '📝 Assign Existing Task': 'assign_task_started',
    '✏️ Update Assignment': 'update_assignment_started',
    '⚙️ Other': 'other_started',
    '🔍 View My Tasks': 'view_my_tasks_started',
    '✏️ Change Assignment Status': 'change_assignment_status_started',
    '📦 View Inactive Tasks': 'view_inactive_tasks_started',
  }

  const key = String(input)
  const nextState = mapping[key]

  // 🛡️ Role-based access check
  if (
    currRole === 'employee' &&
    nextState !== 'view_my_tasks_started' &&
    nextState !== 'mark_assignment_as_complete_started'
  ) {
    return 'unauthorized'
  }

  return nextState || 'invalid'
}

// Get the next state based on the command entered in the "Other" menu
function getOtherCommandNextState(input) {
  /** @type {{ [key: string]: string }} */
  const mapping = {
    '/addC': 'add_client_started',
    '/deleteC': 'delete_client_started',
    '/viewC': 'view_clients_started',
    '/deleteT': 'delete_task_started',
    '/deleteA': 'delete_assignment_started',
    '/addM': 'add_member_started',
    '/updateM': 'update_member_started',
    '/deleteM': 'delete_member_started',
    '/viewM': 'view_members_started',
    '/sendT': 'view_members_started',
    '/genR': 'generate_report_started',
    '/backT': 'backup_taskList_started',
    '/logout': 'log_out',
    '/changePass': 'change_password_started',
  }

  // const key = String(input).trim().toLowerCase()
  const nextState = mapping[input]

  return nextState || 'invalid'
}

// Parse the User's Input when they have entered details of a task
// Reply with no colon found if the user has not entered key:value pair format mein input
function parseKeyValueInput(text) {
  // Split each line
  const lines = text.split('\n')

  let taskData = {}
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
      info: 'Reverting back to add_task_selectedClient because user entered no colons',
      message: 'No colons found in input, please enter task details as Key:Value pairs',
    }
  }

  return { success: true, data: taskData }
}

// Validate the Task Details entered by the user
function validateTaskDetails(data) {
  if (!data.title) {
    return {
      valid: false,
      info: 'Reverting back to add_task_selectedClient because of missing task title',
      message: 'Every task needs a ✨ *title*.\nPlease try again.',
    }
  }

  const allowedKeys = ['title', 'due', 'priority', 'status', 'notes']
  const invalidKeys = Object.keys(data).filter((k) => !allowedKeys.includes(k))

  if (invalidKeys.length > 0) {
    return {
      valid: false,
      info: 'Reverting back to add_task_askForTaskDetails because of incorrect keys entered',
      message: `Unknown field(s): *${invalidKeys.join(', ')}*.\nPlease use only: title, due, and priority.`,
    }
  }

  let parsedDueDate = null
  if (typeof data.due === 'string' && data.due.trim()) {
    const vDate = validateDueDate(data.due.trim())
    if (!vDate.valid) {
      return {
        valid: false,
        info:
          `Reverting back to add_task_askForTaskDetails because of incorrect date.\n` +
          `Reason: ${vDate.reason}`,
        message: `${vDate.reason}\nPlease try again.`,
      }
    }
    parsedDueDate = vDate.parsedDate
  }

  const allowedPriorities = ['low', 'medium', 'high', 'urgent']
  if (data.priority && !allowedPriorities.includes(data.priority.toLowerCase())) {
    return {
      valid: false,
      info: 'Reverting back to add_task_askForTaskDetails because of invalid priority',
      message: `The 🔺 *priority* "${data.priority}" is not valid.\n\nPlease choose one of:\n*low, medium, high, urgent*.`,
    }
  }

  return {
    valid: true,
    dueDate: parsedDueDate ? dateToDMY(parsedDueDate) : null,
  }
}

// Validate a date to be realistic and correctly formatted
function validateDueDate(dateStr) {
  const weekdayMap = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  }

  const lower = dateStr.toLowerCase()

  // 🌸 Handle "today" explicitly
  if (lower === 'today') {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return {
      valid: true,
      parsedDate: today,
      reason: 'Using today as due date',
    }
  }

  // 🌸 Handle "tomorrow" explicitly
  if (lower === 'tomorrow') {
    const tomorrow = new Date()
    tomorrow.setHours(0, 0, 0, 0)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return {
      valid: true,
      parsedDate: tomorrow,
      reason: 'Using tomorrow as due date',
    }
  }
  // 🌼 Check if it's a weekday like "Friday"
  if (Object.prototype.hasOwnProperty.call(weekdayMap, lower)) {
    const today = new Date()
    const todayDay = today.getDay()
    const targetDay = weekdayMap[lower]

    let diff = targetDay - todayDay
    if (diff <= 0) diff += 7 // go to next week's day

    const dueDate = new Date(today)
    dueDate.setDate(today.getDate() + diff)

    return {
      valid: true,
      parsedDate: dueDate,
      reason: `Using next ${capitalize(lower)} as due date`,
    }
  }

  // 🌼 Match DD-MM-YY format
  const regex = /^(\d{2})-(\d{2})-(\d{2})$/
  const match = dateStr.match(regex)
  if (!match) {
    return {
      valid: false,
      reason: 'Date must be in DD-MM-YY format or a valid weekday name.',
    }
  }

  const [dd, mm, yy] = match.slice(1).map(Number)
  const fullYear = 2000 + yy

  if (!isValidDayForMonth(dd, mm, fullYear)) {
    return {
      valid: false,
      reason: `Invalid day ${dd} for month ${mm}.`,
    }
  }

  const dueDate = new Date(fullYear, mm - 1, dd)
  const now = new Date()

  if (dueDate < now.setHours(0, 0, 0, 0)) {
    return {
      valid: false,
      reason: 'Due date is in the past.',
    }
  }

  return {
    valid: true,
    parsedDate: dueDate,
    reason: 'Valid due date in DD-MM-YY format.',
  }
}

function isValidDayForMonth(dd, mm, yyyy) {
  const monthLengths = [31, isLeapYear(yyyy) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= monthLengths[mm - 1]
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

// 🌸 Convert a JS Date object to "YY-MM-DD" (Postgres friendly)
function dateToYYMD(date) {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0') // 0-based month
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

// We use this function to convert Javascript
// Date format to DMY
function dateToDMY(date) {
  const yy = String(date.getFullYear()).slice(-2) // Eg. '25'
  const mm = String(date.getMonth() + 1).padStart(2, '0') // JS months are 0-based
  const dd = String(date.getDate()).padStart(2, '0')
  return `${dd}-${mm}-${yy}`
}

// 🌸 Convert "DD-MM-YY" → "YYYY-MM-DD" (Postgres format)
// function DMYtoYYMD(ddmmyy) {
//   const [dd, mm, yy] = ddmmyy.split('-').map(Number)
//   const yyyy = 2000 + yy // Assumes 20YY; adjust for Y2K gopis if needed
//   return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
// }

// 🌸 Convert "YYYY-MM-DD" → "DD-MM-YY"
function YYMDtoDMY(yyyymmdd) {
  const [yyyy, mm, dd] = yyyymmdd.split('-')
  const yy = yyyy.slice(-2)
  return `${dd}-${mm}-${yy}`
}

// Validate status value
// function validateStatus(givenStatus) {
//   const allowedStatuses = ['pending', 'review', 'done', 'scrapped']
//   if (givenStatus && !allowedStatuses.includes(givenStatus)) {
//     return {
//       valid: false,
//       info: 'Reverting back to add_task_askForTaskDetails because of invalid status',
//       message:
//         `The 📌 *status* "${givenStatus}" is not valid.\n` +
//         `Please choose from: *pending, review, done, scrapped*.`,
//     }
//   }

//   return {
//     valid: true,
//     info: 'Status entered is valid.',
//   }
// }

// We use this function to format DD-MM-YY date into cute format to display to the user
function cuteDate(ddmmyy) {
  const [dd, mm, yy] = ddmmyy.split('-').map(Number)
  const yyyy = 2000 + yy
  const date = new Date(yyyy, mm - 1, dd)
  date.setHours(0, 0, 0, 0)

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const tomorrow = new Date()
  tomorrow.setHours(0, 0, 0, 0)
  tomorrow.setDate(tomorrow.getDate() + 1)

  // 🌸 Special names
  if (date.getTime() === today.getTime()) {
    return 'Today'
  }
  if (date.getTime() === tomorrow.getTime()) {
    return 'Tomorrow'
  }

  // For far-future dates, just return as-is
  if (yyyy > 2025) {
    return ddmmyy
  }

  const day = date.getDate()

  // 🌿 Calculate suffix like 1st, 2nd, 3rd, 4th...
  let daySuffix = 'th'
  if (day % 100 < 11 || day % 100 > 13) {
    switch (day % 10) {
      case 1:
        daySuffix = 'st'
        break
      case 2:
        daySuffix = 'nd'
        break
      case 3:
        daySuffix = 'rd'
        break
    }
  }

  const monthName = date.toLocaleString('default', { month: 'long' })
  const weekday = date.toLocaleString('default', { weekday: 'long' })

  return `${day}${daySuffix} ${monthName}, ${weekday}`
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

// This function takes details to generate an SQL Update Query for track_session, and then returns the object
function updateSessionQuery(
  updateInfo,
  nextStateStack,
  nextContextData,
  nextProcessingFlag,
  telegramID
) {
  let contextUpdateClause

  // Case 1: SQL snippet directly passed (e.g., jsonb_set(...) )
  if (typeof nextContextData === 'string') {
    contextUpdateClause = `context_data = ${nextContextData.trim()}`

    // Case 2: JSON object passed — convert to proper JSONB
  } else if (
    typeof nextContextData === 'object' &&
    nextContextData !== null &&
    Object.keys(nextContextData).length > 0
  ) {
    contextUpdateClause = `context_data = '${JSON.stringify(nextContextData)}'::jsonb`

    // Case 3: No context update needed — keep as is
  } else {
    contextUpdateClause = `context_data = context_data`
  }

  return {
    json: {
      route: 'updateSession',
      info: updateInfo,
      query: `
        UPDATE track_session
        SET
          state = '${JSON.stringify(nextStateStack)}'::jsonb,
          ${contextUpdateClause},
          processing_flag = ${nextProcessingFlag},
          last_updated = NOW()
        WHERE telegram_id = '${telegramID}';
      `.trim(),
    },
  }
}

function telegramMessage(info, message) {
  return {
    json: {
      route: 'telegramNode',
      info: info,
      message: message,
    },
  }
}

// 🌷 Main renderer function
function renderTasksView({ clients, tasks, assignments }) {
  if (!Array.isArray(clients) || !clients.length) return '🌱 No clients to display.'
  if (!Array.isArray(tasks) || !tasks.length) return '🌱 No tasks found.'
  const lines = []

  const statusMap = {
    pending: '🟡 Pending',
    review: '🔵 In Review',
    done: '✅ Done',
    scrapped: '🗑️ Scrapped',
  }

  const priorityOrder = {
    urgent: 1,
    high: 2,
    medium: 3,
    low: 4,
  }

  for (const client of clients) {
    // Get all the tasks belonging to the current client
    const clientTasks = tasks
      .filter((t) => t.client_uid === client.uid)
      .sort((a, b) => {
        return priorityOrder[a.priority] - priorityOrder[b.priority]
      })

    // If the current client has no tasks then continue
    if (!clientTasks.length) continue

    // First writing the client name as a cute header
    lines.push(`👨‍💼 ${client.name}`)
    lines.push('────────────────────────────')

    // Loop over each of the tasks belonging to this client
    for (const task of clientTasks) {
      lines.push(`📋 ${capitalize(task.title)}`)

      // Remember not to perform any validations here, this function is just for rendering text
      if (task.due) {
        lines.push(`📅 ${task.due}`)
      }

      if (task.priority) {
        lines.push(`⚡ ${capitalize(task.priority)}`)
      }

      if (task.status) {
        lines.push(`${statusMap[task.status]}`)
      }

      // 📝 If notes exist, display them
      if (task.notes) {
        lines.push(`📝 Notes: ${task.notes}`)
      }

      const taskAssignments = assignments.filter((a) => a.task_uid === task.uid)
      if (taskAssignments.length) {
        lines.push(`\n👥 Assignments:`)
        for (const a of taskAssignments) {
          const resp = a.resp ? ` → "${a.resp}"` : ``
          const due = a.due ? `\n📅 ${a.due})` : ``
          const priority = a.priority ? `\n⚡ ${capitalize(a.priority)}` : ``
          const status = a.status ? `\n${statusMap[a.status]}` : ``
          lines.push(`📝 ${a.first_name}${resp}${due}${priority}${status}`.trim())
          lines.push('') // Empty line between assignments
        }
      }

      lines.push('') // Empty line between tasks
    }

    lines.push('') // Extra space between clients
  }

  return lines.join('\n').trim()
}

// Return correct value for SQL field and escape single quotes
// function ess(value) {
//   if (value == null) return null
//   if (typeof value !== 'string') return `'${value}'`
//   return `'${value.replace(/'/g, "''")}'`
// }
