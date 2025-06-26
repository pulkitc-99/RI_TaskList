# Guide + Documentation of Task List Workflow

The Task List workflow is at: https://n8n.routeignite.com/workflow/8vF2laRENHdw8HRs

## Tech Stack
Telegram as the front-end
n8n as the back end and trigger handler
Supabase postgres as the database

## Structure

The workflow is triggered by interacting with the telegram bot.

We perform two checks:
Is the user valid?
Is the workflow already processing something for the user?

We retrieve the user’s details as well as the user’s session details to perform these checks, and use them for our workflow.

Since n8n is stateless, we use a table called track_session to keep track of the workflow and interaction with the user.

The state of the table is a JSON. We are using JSON instead of a string so that we can treat it like a stack, having flows layered on top of each other and being popped when their work is done. This helps facilitate sub-flows.

Based on the state, we enter a code node that is the brain of the workflow. It determines which route to take next, what action must be performed, what to tell the user etc.
Based on the route taken, the workflow uses a switch node and enters flows that contain one of the following:
- AI Agent that performs actions such as:
- Parsing user’s input
- Formatting the output for the user
- A telegram node to interact with the user - display results, ask for input, issue warnings etc.
- A postgres node to interact with the database
- An IF node that further determines which route to take, whether to loop the program back to the code node etc.
- A loop-over-items node that handles data items in batches.
- A google sheets node to update the mirror of the database in google sheets.


Every time workflow is executed with telegram, manually send a request to postgres node to set flags to false.

## Database Schema



## Session State Values
The naming of state is based on what is happening presently as the workflow is activated.






## Future Scope

   Edit the code and database to have a better flow of the code. Using more functions. Client List presenting and retrieving can occur whenever needed and this sub-state can be added as a stack and then removed, to resume processing.

   Implementing cute forms to replace certain functionalities shortly.
   Possibly Implementing this is a complete full stack customized app soon - this shall replace the interaction from telegram, and also replace the backend from n8n to something else entirely. - Low priority.

   Adding Analytics of Task List as well as lovely data visualization with external tools. Workload, client's share of tasks using pie chart and other things.

   Change all database commands to parameterized passing and sanitize input to avoid SQL Injections.

## Learnings

   Implement features depth-first rather than breadth-first. This means, don’t build the entire possibilities of workflow from the beginning. Implement one particular route functionality fully so you can identify challenges and then use what you learn.

   n8n nodes can have lot of internal checks and quirks that breaks things, so try to handle things as much as possible within code nodes and pass clean data. Use simple settings.

   Multiple items sent at once get fired in parallel by any node in n8n. You need to make sure items don't collide or cause ambiguity between nodes.
   Don't output multiple items for a single node in a parallel node setup. It will all execute at once and cause issues. Make sure each parallel node gets only one task.

   Before beginning development, make sure you are using the most suitable software stack for your work so that you don't have problems in the future. For this purpose, n8n was not suitable.

   Changing SQL work from doing directly to an executing_sql node. This would allow for one single postgres node that handles all postgres node queries and executes them one by one. Further, we can have a processing_node that simply performs all the actions one by one such as SQL queries, telegram node, google sheet etc. and once all of that is done, we would continue. However, this feels too unnecessarily complicated and n8n will likely cause errors. This is better for an app. For now, continuing with current design.