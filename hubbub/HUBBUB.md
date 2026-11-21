# How to fill in this project for HUBBUB (Systoned)

HUBBUB is Jordie's dashboard. It shows what is being worked on in this project. It reads two files in the `hubbub/` folder of this project:

- `hubbub/status.json`: the list of work (objectives and their tasks).
- `hubbub/ONE-PAGER.md`: a short description of the project.

Both start empty. Your job is to fill them in, and Jordie checks everything before it is saved.

## Step 1: Look at the project

Read the README, CLAUDE.md, any plan or to-do files, and the recent git history (`git log --oneline -30`). Do not guess. If something is not written down, ask Jordie.

## Step 2: Write a draft and show it to Jordie

Write the draft in the chat, not in the files yet. Use plain words. Show:

1. **What the project is for**, in one or two sentences.
2. **The objectives.** An objective is one big piece of work with a clear finish, for example "Session import" or "Phone layout". For each one, say:
   - its name,
   - one sentence on what it gives the user,
   - whether it is finished, being worked on, or only an idea,
   - its tasks: the steps to finish it, each starting with a verb, for example "Write the file reader".
3. **Questions for Jordie**: anything you could not work out from the files.

Then ask Jordie: "Is this right? What should I change?"

## Step 3: Change it until Jordie says it is right

Do not save anything until Jordie says yes.

## Step 4: Save the two files

**hubbub/ONE-PAGER.md**, with these four headings:

```markdown
# <Project name>

## Aim
What the project is for and who it is for.

## How it is built
The main parts and where they live.

## Rules
Things anyone working here must keep to (only ones Jordie or the docs have stated).

## Key files
The files that matter most, one line each.
```

**hubbub/status.json**, keeping the `project` and `color` already in the file:

```json
{
  "project": "Poker ladder",
  "state": "In progress",
  "color": "#2B4BD9",
  "objectives": [
    {
      "id": "session-import",
      "name": "Session import",
      "description": "Players upload a session file and see it on their ladder page.",
      "state": "Planning",
      "plan": "Write the file reader, then add an upload page.",
      "plan_approved": false,
      "tasks": [
        { "id": "t1", "name": "Write the file reader", "state": "To do" },
        { "id": "t2", "name": "Add the upload page", "state": "To do" }
      ],
      "questions": [
        { "id": "q1", "text": "Should duplicate sessions be skipped?", "answer": null }
      ],
      "notes": [],
      "feedback": []
    }
  ]
}
```

What each field means:

| Field | Meaning |
|---|---|
| `id` | A short name with dashes, like `session-import`. Never change it once saved. |
| `name` | What Jordie sees. A few words. |
| `description` | One sentence on what it gives the user. |
| `state` | `Idea` (only an idea), `Planning` (plan written, waiting for Jordie), `With agent` (being worked on), `Done` (finished). |
| `plan` | What you would do, in 1 to 4 sentences. |
| `plan_approved` | Always `false` when you write it. Jordie approves it on the dashboard. Work only starts after that. |
| `tasks` | The steps. Ids `t1`, `t2`... State `To do` or `Done`. |
| `questions` | Questions for Jordie. Ids `q1`, `q2`... `answer` is `null`. |
| `notes`, `feedback` | Leave as empty lists `[]`. Jordie adds these on the dashboard. |

Check the file is valid: `python3 -c "import json; json.load(open('hubbub/status.json'))"`

The dashboard updates within a minute of saving.

## After that: keeping it up to date

- When you finish a task, set it to `Done`.
- `Doing` means you are editing that task right now. Set it back to `To do` or `Done` before you stop.
- Never rename or delete objectives or tasks. Never change Jordie's answers, notes or feedback.
- If a decision is Jordie's, add a question and stop.
- Jordie's feedback appears in an objective's `feedback` list. Do each item with `"done": false`, then set it to `true`.
- When working on an approved objective, also follow `~/HUB/orchestrator/AGENT_GUIDE.md`.
