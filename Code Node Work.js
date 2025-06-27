// 📦 Extract commonly used session & user details from previous nodes
const session = $('Updated Session').first().json.state
const context = $('Updated Session').first().json.context_data || {}
const processing_flag = $('Updated Session').first().json.processing_flag
const currInput = $('Trigger upon receiving telegram message').first().json.message.text
const currUserID = $('Trigger upon receiving telegram message').first().json.message.from.id // this means telegram ID
const currUserName = $('Get User Details').first().json.first_name
const currRole = $('Get User Details').first().json.role
const currMemberID = $('Get User Details').first().json.uid // this means 5 digit member ID

// Extract current state from the state stack
let currState = peekState(session)

if (processing_flag == true) {
  // 🌸 Start of the divine state based routing

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
        false
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
        {
          json: {
            route: 'greetNode',
          },
        },
        telegramMessage(
          `Informing user of invalid command`,
          `Hmm... I couldnt understand what you want. Please choose from the options provided. Let's try again.`
        ),
        updateSessionQuery(
          'revert from session_started back to new_session because of invalid command',
          newStateStack,
          context,
          false
        ),
      ]
    } else if (nextState === 'unauthorized') {
      const newStateStack = replaceTopState(session, 'new_session')
      return [
        {
          json: {
            route: 'greetNode',
          },
        },
        telegramMessage(
          `Informing user of they are not authorized`,
          `Hmm... it seems you are not authorized to do that. Please choose from the options provided. Let's try again.`
        ),
        updateSessionQuery(
          'revert from session_started back to new_session because of invalid command',
          newStateStack,
          context,
          false
        ),
      ]
    } else {
      const newStateStack = pushState(replaceTopState(session, 'session_ongoing'), nextState)
      return [
        updateSessionQuery(
          `Updating state to push ${nextState} on the stack`,
          newStateStack,
          context,
          true
        ),
      ]
    }
  }

  // 🌸 Flow: Add a new Task
  // State: add_task_started
  // If it has just started, retrieve the list of clients by calling the subflow
  // Next state: add_task_retrievedClients
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

    // 🌼 Extract client list from context_data
    const clientList = Array.isArray(context.add_task.client_list)
      ? context.add_task.client_list
      : []
    // TODO Inform the user if no clients exist - Special Case and ask to create one through /new
    // TODO Do this for assignments too (and ask to create task first) -- do that for members too and anything that is fetched
    const sortedClientList = clientList.sort((a, b) => (a.name || '').localeCompare(b.name || ''))

    const clientText = sortedClientList
      .map((client) => `🔹 ${client.name} (/${client.uid})`)
      .join('\n')
    // Prepare message to ask the user to choose a client from the list
    const message =
      `🌷 ${currUserName},\n` +
      `Please choose a client for this task:\n\n${clientText}\n\n` +
      `👉 Click on the *UID* next to the client's name.\n` +
      `🌱 Or click /new to create a new client.`

    return [
      telegramMessage(`Sending list of clients to user and asking for selection`, message),
      updateSessionQuery(
        `Client List fetched. The user shall select a client. Updating state from add_task_retrievedClients to add_task_checkSelectedClient`,
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
                jsonb_build_object('caller', 'add_task')::jsonb,
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

    const foundClient = clientList.find(
      (client) => client.uid.toLowerCase() === clientInput.toLowerCase()
    )

    if (!foundClient) {
      const revertStateStack = replaceTopState(session, 'add_task_retrievedClients')
      return [
        telegramMessage(
          'Client not found — prompting user to try again',
          `⚠️ Hmm, I couldn't find a client by that name or UID. Please try again.\n`
        ),
        updateSessionQuery(
          `Invalid client input, reverting to add_task_retrievedClients`,
          revertStateStack,
          context,
          true
        ),
      ]
    }

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
      `*priority*: High\n\n` +
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
    const selectedClient = context.add_task.selected_client || {}

    // 🌿 Parse key:value input using helper function
    const parsedResult = parseTaskDetails(taskText)

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
    const formattedMessage =
      `🧑‍💼💼 ${selectedClient.name} [${selectedClient.uid}]\n\n` +
      `📝 ${taskData.title}\n` +
      (taskData.due ? `📅 ${taskData.due}\n` : '') +
      (taskData.priority ? `⚡ ${taskData.priority}\n` : '') +
      `👥 —\n` +
      `✅ If this looks good, click /yes to confirm.\n` +
      `🚫 Or click /no to enter task details again.`

    return [
      telegramMessage(
        'Confirming task details with user (yes/no) in formatted client card style',
        formattedMessage
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
  // and then first retrieve all the current tasks' UIDs so that we can generate a unique one
  // Next state: add_task_retrievedTaskUIDs
  if (currState === 'add_task_verifiedTaskDetails') {
    const input = String(currInput).trim().toLowerCase().replace('/', '')

    // If the user says "no" to the task details, then ask for it again
    if (input === 'no') {
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
          jsonb_set(
            COALESCE(context_data, '{}'::jsonb),
            '{add_task,task_details}',
            'null'::jsonb,
            true
          )
          `,
          true
        ),
      ]
    }

    // If the user says "yes" to the task details, then retrieve all current tasks UIDs.
    else if (input === 'yes') {
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
          'Please only reply with either */yes* to confirm or */no* to re-enter task details. 👩‍🏫'
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
  // into the database
  // Next state: add_task_taskAdded
  if (currState === 'add_task_retrievedTaskUIDs') {
    const selectedClient = context.add_task.selected_client
    const taskDetails = context.add_task.task_details
    const formattedDueDate = taskDetails.due ? convertToPostgresDate(taskDetails.due) : null
    const taskPriority = taskDetails.priority ? taskDetails.priority : 'medium'
    const tasksUIDList = context.add_task.task_list.map((task) => task.uid)

    // Generate Task UID (e.g., T4X2A)
    const taskUID = generateUID('T', tasksUIDList)
    const newStateStack = replaceTopState(session, 'add_task_taskAdded')

    const fields = {
      uid: taskUID,
      client_uid: selectedClient.uid,
      title: taskDetails.title,
      due_date: formattedDueDate ? `'${formattedDueDate}'` : 'NULL',
      priority: taskPriority,
      status: 'Not Started',
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
      telegramMessage(
        'Asking user if they want to assign newly added task',
        `✅ Task added successfully!\n\n✨ Would you like to assign this task to someone?\n\n` +
          `🧘‍♀️ Click */yes* to assign.\n🌼 Click */no* to skip.`
      ),
      updateSessionQuery(
        `Updating state after task added`,
        newStateStack,
        `jsonb_set(
          COALESCE(context_data, '{}'::jsonb),
          '{add_task,task_details,new_uid}',
          to_jsonb('${taskUID}'::text),
          true
        )`,
        false
      ),
    ]
  }

  // 🌸 Flow: Add a new Task
  // State: add_task_taskAdded
  // The task has been added and user was asked whether to assign it
  // If YES: Next state stack → add_task_assignedTaskAdded, assign_task
  // If NO: Pop the state and continue gracefully
  if (currState === 'add_task_taskAdded') {
    const input = String(currInput).trim().toLowerCase().replace('/', '')

    if (input === 'yes') {
      // TODO Add this flow -- if they say yes, check which data is needed and make the context_data like so
      // TODO check this flow fully
      const newStateStack = pushState(
        pushState(
          replaceTopState(session, 'add_task_assignedTaskAdded'),
          'assign_task_askForAssignees'
        ),
        'fetch_members'
      )
      return [
        updateSessionQuery(
          `User agreed to assign task — updating state stack to assign_task`,
          newStateStack,
          `jsonb_set(
            jsonb_set(
              COALESCE(context_data, '{}'::jsonb),
              '{assign_task,caller}',
              to_jsonb('add_task'),
              true
            ),
            '{assign_task,selected_task_uid}',
            to_jsonb('${context.add_task.task_details.uid}'),
            true
          )`,
          true
        ),
      ]
    } else if (input === 'no') {
      const poppedStateStack = popState(session)

      return [
        updateSessionQuery(
          'Popping taskAdded state, going back to session_ongoing',
          poppedStateStack,
          `'{}'::jsonb`,
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
            `🧘‍♀️ Reply *yes* to assign.\n🌼 Reply *no* to skip.`
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
        `'{}'::jsonb`,
        true
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_started
  // Started assigning an existing task, we fetch client list to ask user
  // Next state stack: ..., assign_task_retrievedClientList, fetch_clients
  if (currState === 'assign_task_started') {
    const newStateStack = pushState(
      replaceTopState(session, 'assign_task_retrievedClientList'),
      'fetch_clients'
    )
    return [
      updateSessionQuery(
        `Fetching clients to determine task for assignment. Pushing fetch_clients on stack`,
        newStateStack,
        `
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
          )
        `,
        true
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_retrievedClientList
  // Retrieved list of clients. Prepare message and ask user to select with clickable UIDs
  // Next state: ..., assign_task_selectedClient
  if (currState === 'assign_task_retrievedClientList') {
    const newStateStack = replaceTopState(session, 'assign_task_selectedClient')

    // 🌼 Extract client list from context_data
    const clientList = Array.isArray(context.assign_task?.client_list)
      ? context.assign_task.client_list
      : []

    const sortedClientList = clientList.sort((a, b) => (a.name || '').localeCompare(b.name || ''))

    const clientText = sortedClientList
      .map((client) => `🔹 ${client.name} (/${client.uid})`)
      .join('\n')

    // Prepare message to ask the user to choose a client from the list
    const message =
      `🌷 ${currUserName},\n` +
      `Please choose the client to whom the task to be assigned belongs to:\n\n${clientText}\n\n👉` +
      `🌱 Click on the client's UID displayed next to their name.`

    return [
      telegramMessage(`Sending list of clients to user and asking for selection`, message),
      updateSessionQuery(
        `Client List fetched. The user shall select a client. ` +
          `Updating state from assign_task_retrievedClientList to assign_task_selectedClient`,
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
  // Next state stack: ..., assign_task_retrievedTaskList, fetch_tasks
  if (currState === 'assign_task_selectedClient') {
    const clientInput = String(currInput).trim().toLowerCase().replace('/', '')

    // Fetch client list and check whether entered client exists in the database
    const clientList = Array.isArray(context.assign_task.client_list)
      ? context.assign_task.client_list
      : []

    const foundClient = clientList.find(
      (client) =>
        client.uid.toLowerCase() === clientInput.toLowerCase() ||
        client.name.toLowerCase() === clientInput.toLowerCase()
    )

    if (!foundClient) {
      const revertStateStack = replaceTopState(session, 'assign_task_retrievedClientList')
      return [
        telegramMessage(
          'Client not found — prompting user to try again',
          `⚠️ Hmm, I couldn't find a client by that name or UID. Please try again.\n`
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
      replaceTopState(session, 'assign_task_retrievedTaskList'),
      'fetch_tasks'
    )
    return [
      updateSessionQuery(
        `Client ${foundClient.name} selected — saving in context_data and moving to fetch task list`,
        newStateStack,
        // In the following we are adding selected client, removing client list, and adding caller for fetch tasks
        `jsonb_strip_nulls(
          jsonb_set(
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
        )`,
        true
      ),
      telegramMessage(
        `tell wonderful after selecting client to make them feel like a star`,
        `✨ Wonderful!`
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_retrievedTaskList
  // Show user all the tasks and ask them to select one with clickable task UID
  // Next state stack: ..., assign_task_selectedTask
  if (currState === 'assign_task_retrievedTaskList') {
    const newStateStack = replaceTopState(session, 'assign_task_selectedTask')

    // 🌼 Extract task list from context_data
    const taskList = Array.isArray(context.assign_task?.task_list)
      ? context.assign_task.task_list
      : []

    // 🌼 Extract selected client UID to filter tasks for that client
    const selectedClientUID = context.assign_task?.selected_client?.uid || ''

    // 🌼 Filter tasks belonging to selected client
    const filteredTaskList = taskList.filter(
      (task) => (task.client_uid || '').toLowerCase() === selectedClientUID.toLowerCase()
    )

    // 🌼 Sort filtered tasks by title
    const sortedTaskList = filteredTaskList.sort((a, b) =>
      (a.title || '').localeCompare(b.title || '')
    )

    // 🌼 Prepare task display text
    const taskText = sortedTaskList.length
      ? sortedTaskList.map((task) => `🔹 ${task.title} (/${task.uid})`).join('\n')
      : '⚠️ No tasks found for this client.'

    // DEAR GOPI DESK:
    // TODO if the selected client has no tasks, then don't show them. Better yet, only show clients which have tasks. Filter them here.
    // TODO inform the user that clients having tasks are only displayed
    // 🌼 Prepare message for user
    const message =
      `Please choose the task you wish to assign:\n\n${taskText}\n\n👉` +
      (sortedTaskList.length ? `🌱 Click on the task's UID displayed next to its title.` : ``)

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

    const selectedClientUID = context.assign_task?.selected_client?.uid || ''

    // Filter tasks belonging to the selected client
    const filteredTaskList = taskList.filter(
      (task) => (task.client_uid || '').toLowerCase() === selectedClientUID.toLowerCase()
    )

    // Try to find task with matching UID
    const selectedTask = filteredTaskList.find(
      (task) => (task.uid || '').toLowerCase() === taskInput.toLowerCase()
    )

    // If task is not found, ask user to re-enter
    if (!selectedTask) {
      const revertStateStack = replaceTopState(session, `assign_task_retrievedTaskList`)
      return [
        telegramMessage(
          'Invalid task UID entered',
          `❌ That doesn't seem like a valid task UID.\nPlease click on a task from the list.`
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
            'client_uid', '${selectedTask.client_uid}'
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
    const sortedmemberList = memberList.sort((a, b) =>
      (a.first_name || '').localeCompare(b.first_name || '')
    )

    // 🌼 Prepare members display text
    const memberText = sortedmemberList.length
      ? sortedmemberList.map((member) => `🔹 ${member.first_name} (/${member.uid})`).join('\n')
      : '⚠️ No members found.'

    // 🌼 Prepare message for user
    const message =
      `Please choose a member to assign this task to:\n\n${memberText}\n\n👉` +
      (sortedmemberList.length ? `🌱 Click on the member's UID displayed next to their name.` : ``)

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
      (member) => (member.uid || '').toLowerCase() === memberInput.toLowerCase()
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

    // 🌼 Clean up member list, and add selected member to context_data
    const updateContextQuery = `
      jsonb_strip_nulls(
        jsonb_set(
          context_data,
          '{assign_task,selected_member}',
          jsonb_build_object(
            'uid', '${selectedMember.uid}',
            'first_name', '${selectedMember.first_name}'
          ),
          true
        )
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
  // Next state stack: ..., assign_task_receivedAssignmentDetails
  if (currState === 'assign_task_askForAssignmentDetails') {
    // 🌼 Ask user for assignment-specific details
    const detailsMessage =
      `✨ Almost there! Let's add a few optional details for this assignment:\n\n` +
      `Please use *Key:Value* format. For example:\n\n` +
      `*responsibility*: Call client and update sheet\n` +
      `*priority*: High\n` +
      `*due*: 01-07-25\n\n` +
      `🌱 You can type any or all. To skip, simply click here → */skip*.`

    const newStateStack = replaceTopState(session, 'assign_task_receivedAssignmentDetails')

    return [
      telegramMessage('Asking user for assignment-specific details', detailsMessage),
      updateSessionQuery(
        `Asked user to enter assignment details. Moving to assign_task_receivedAssignmentDetails`,
        newStateStack,
        context,
        false
      ),
    ]
  }

  // 🌸 Flow: Assign an existing task
  // State: assign_task_receivedAssignmentDetails
  // Validate the assignment details entered by the user or /skip.
  // Insert the assignment details into context_data
  // Ask the user to confirm assignment
  // Next state stack: ..., assign_task_validatedAssignmentDetails
  if (currState === 'assign_task_receivedAssignmentDetails') {
    const userInput = String(currInput).trim()

    const newStateStack = pushState(
      replaceTopState(session, 'assign_task_validatedAssignmentDetails'),
      'fetch_assignments'
    )

    const selectedTask = context.assign_task?.selected_task || {}
    const selectedClient = context.assign_task?.selected_client || {}
    const selectedMember = context.assign_task?.selected_member || {}

    const taskDue = selectedTask.due_date || ''
    const taskPriority = selectedTask.priority || ''
    const taskStatus = selectedTask.status || ''

    // 🧚 If user skipped input
    if (userInput.toLowerCase() === '/skip') {
      const confirmMessage =
        `🧑‍💼💼 ${selectedClient.name} [${selectedClient.uid}]\n\n` +
        `📌 ${selectedTask.title} [${selectedTask.uid}]\n` +
        (taskDue ? `📅 ${taskDue}\n` : '') +
        (taskPriority ? `⚡ ${taskPriority}\n` : '') +
        (taskStatus ? `📌 ${taskStatus}\n` : '') +
        `\n👤 ${selectedMember.first_name} [${selectedMember.uid}]\n\n` +
        `🌿 No extra assignment details provided.\nTask's original values will be used.\n\n` +
        `✅ Click */yes* to confirm assignment.\n🚫 Or click */no* to change details.`

      return [
        telegramMessage(`Asking user to confirm assignment after /skip`, confirmMessage),
        updateSessionQuery(
          `User skipped assignment details. Proceeding to validatedAssignmentDetails and fetch_assignments`,
          newStateStack,
          `
          jsonb_strip_nulls(
            jsonb_set(
              jsonb_set(
                context_data,
                '{assign_task,assignment_details}',
                '{"responsibility": null, "priority": null, "due": null}'::jsonb,
                true
              ),
              '{fetch_assignments}',
              jsonb_build_object('caller', 'assign_task'),
              true
            )
          )
          `,
          false
        ),
      ]
    }

    // 🌿 Parse user input
    const parsedResult = parseTaskDetails(userInput)
    if (!parsedResult.success) {
      const revertStateStack = replaceTopState(session, 'assign_task_askForAssignmentDetails')
      return [
        telegramMessage(parsedResult.info, parsedResult.message),
        updateSessionQuery(parsedResult.info, revertStateStack, context, true),
      ]
    }

    const data = parsedResult.data
    const allowedKeys = ['responsibility', 'priority', 'due']
    const invalidKeys = Object.keys(data).filter((k) => !allowedKeys.includes(k))

    if (invalidKeys.length > 0) {
      const revertStateStack = replaceTopState(session, 'assign_task_askForAssignmentDetails')
      return [
        telegramMessage(
          `Invalid fields entered`,
          `❌ Unknown field(s): *${invalidKeys.join(', ')}*\nPlease use only: *responsibility, priority, due*`
        ),
        updateSessionQuery(`Invalid fields in assignment input`, revertStateStack, context, true),
      ]
    }

    if (data.due && !validateDueDate(data.due)) {
      const revertStateStack = replaceTopState(session, 'assign_task_askForAssignmentDetails')
      return [
        telegramMessage(
          `Invalid due date`,
          `📅 The due date "${data.due}" isn't valid.\nUse format: *DD-MM-YY*.`
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

    // 🌟 Final confirm message with all values
    const confirmMessage =
      `🧑‍💼💼 ${selectedClient.name} [${selectedClient.uid}]\n\n` +
      `📌 ${selectedTask.title} [${selectedTask.uid}]\n` +
      (taskDue ? `📅 ${taskDue}\n` : '') +
      (taskPriority ? `⚡ ${taskPriority}\n` : '') +
      (taskStatus ? `📌 ${taskStatus}\n` : '') +
      `\n👤 ${selectedMember.first_name} [${selectedMember.uid}]\n` +
      (data.responsibility ? `📝 Responsibility: ${data.responsibility}\n` : '') +
      (data.priority ? `⚡ Priority: ${data.priority}\n` : '') +
      (data.due ? `📅 Due: ${data.due}\n` : '') +
      `\n✅ Click */yes* to confirm assignment.\n🚫 Click */no* to re-enter.`

    return [
      telegramMessage(`Confirming assignment with user`, confirmMessage),
      updateSessionQuery(
        `Valid assignment details received. Proceeding to validatedAssignmentDetails`,
        newStateStack,
        `
      jsonb_strip_nulls(
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
    const task = context.assign_task?.selected_task || {}
    const member = context.assign_task?.selected_member || {}
    const details = context.assign_task?.assignment_details || {}
    const formattedDueDate = details.due ? convertToPostgresDate(details.due) : null

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
      responsibility,
      due_date,
      priority
    )
    VALUES (
      '${assignmentUID}',
      '${task.uid}',
      '${member.uid}',
      '${currMemberID}',
      'Not Started',
      ${details.responsibility ? `'${details.responsibility.replace(/'/g, "''")}'` : 'NULL'},
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
          `
          jsonb_strip_nulls(
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
            )
          )
          `,
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

  // 🌸 Flow: Asking what user wants to do when selected other
  // State: other_started
  // Present all options to user and ask what they would like to do
  if (currState === 'other_started') {
    const newStateStack = replaceTopState(session, 'check_other_command')

    const message =
      `🌻 ${currUserName},\nPlease enter a command from the list below:\n\n` +
      `👥 Clients\n` +
      `/addC\nAdd a new client\n` +
      `\n\n📋 Tasks\n` +
      `/assignT\nAssign an existing task to a team member\n` +
      `\n\n👤 Members\n` +
      `\n\n🌈 More coming soon...`
    return [
      telegramMessage('Present list of other commands to user', message),
      updateSessionQuery(
        `State changes from other_started to check_other_command. We check what "other" command the user enters.`,
        newStateStack,
        context,
        false
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
          false
        ),
      ]
    } else {
      const newStateStack = replaceTopState(session, nextState)
      return [
        updateSessionQuery(
          `Updating state to push ${nextState} on top of session_ongoing`,
          newStateStack,
          context,
          true
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
    const rawInput = String(currInput || '')
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

      return [
        telegramMessage(`Duplicate client name detected`, message),
        updateSessionQuery(
          `Duplicate client. Remaining in add_client_receivedClientName.`,
          session,
          context,
          false
        ),
      ]
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
                        'created_at', created_at
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

  // 🌸 Subflow: fetching all members details from the database
  // State: fetch_members
  // Pop the stack after this is complete
  if (currState === 'fetch_members') {
    const newStateStack = popState(session)
    const caller = context.fetch_members?.caller

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
                        'team', team,
                        'email_id', email_id,
                        'telegram_id', telegram_id,
                        'communication_preference', communication_preference,
                        'role', role
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
        true
      ),
    ]
  }

  // 🌸 Subflow: fetching all assignment details from the database
  // State: fetch_assignments
  // Pop the stack after this is complete
  if (currState === 'fetch_assignments') {
    const newStateStack = popState(session)
    const caller = context.fetch_assignments?.caller

    return [
      updateSessionQuery(
        `fetch_assignments: Fetching assignments and placing in context_data for caller '${caller}', then cleaning fetch_assignments`,
        newStateStack,
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
                        'due_date', due_date,
                        'task_uid', task_uid,
                        'member_uid', member_uid,
                        'responsibility', responsibility,
                        'uid', uid,
                        'status', status,
                        'assigned_by', assigned_by,
                        'priority', priority
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
    '✏️Mark Assignment as Complete': 'mark_assignment_as_complete_started',
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
    '/assignT': 'assign_task_started',
    '/deleteC': 'delete_client_started', // placeholder if you add later
    '/deleteT': 'delete_task_started', // placeholder if you add later
    '/addM': 'add_member_started', // placeholder if you add later
  }

  // const key = String(input).trim().toLowerCase()
  const nextState = mapping[input]

  return nextState || 'invalid'
}

// Parse the User's Input when they have entered details of a task
// Reply with no colon found if the user has not entered key:value pair format mein input
function parseTaskDetails(text) {
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

  const allowedPriorities = ['low', 'medium', 'high', 'urgent']
  if (data.priority && !allowedPriorities.includes(data.priority.toLowerCase())) {
    return {
      valid: false,
      info: 'Reverting back to add_task_selectedClient because of invalid priority',
      message: `The 🔺 *priority* "${data.priority}" is not valid.\nPlease choose one of: *low, medium, high, urgent*.`,
    }
  }

  const allowedStatuses = ['Not Started', 'In Progress', 'Completed', 'Halted', 'In Review']
  if (data.status && !allowedStatuses.includes(data.status)) {
    return {
      valid: false,
      info: 'Reverting back to add_task_selectedClient because of invalid status',
      message: `The 📌 *status* "${data.status}" is not valid.\nPlease choose from: *Not Started, In Progress, Completed, Halted, In Review*.`,
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
  const [dd, mm, yy] = match.slice(1).map(Number)
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return false

  // Check if date is realistic - not in the past and not in 100 years from present date
  const fullYear = 2000 + yy
  const dueDate = new Date(fullYear, mm - 1, dd)
  const now = new Date()
  const hundredYearsFromNow = new Date(now.getFullYear() + 100, 0, 1)

  return dueDate >= now && dueDate < hundredYearsFromNow
  // TODO add a specific message for date being in the past and date being in the future, with humour
  // TODO realistic date better - 31st for months having only 30 days
  // TODO it should accept a lot of types of dates DD-MM-YYYY / D-M-YY - or any combination and the gopis should handle it
  // TODO it should also be able to handle non date types formats - and for this it can be a different function that converts into a data like tomorrow, 5 days from now, Friday, etc. like that.
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

// We use this function to convert DD-MM-YY format date to
// postgres format of YYYY-MM-DD
function convertToPostgresDate(ddmmyy) {
  const [dd, mm, yy] = ddmmyy.split('-').map(Number)
  const yyyy = 2000 + yy // Assuming 20YY; adjust if you're crossing centuries
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

// This function takes details to generate an SQL Update Query for track_session, and then returns the object
function updateSessionQuery(updateInfo, nextStateStack, nextContextData, nextProcessingFlag) {
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
        WHERE telegram_id = '${currUserID}';
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
