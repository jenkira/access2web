# Spike 5 validation pack

| Field | Value |
|---|---|
| Status | Ready to run |
| Owner | Clint Jenkinson |
| Date | 2 October 2026 |
| Version | 0.1 |
| Spike | [Spike 5 report](spike-5-form-editor.md) |

## Summary

This pack holds what you need to run the two parts of Spike 5 that need real people: the owner's ratings of the rendered forms (plan step 3), and the usability session with three users (plan step 11). Run them at the end, after the other spikes, as you decided.

The pack does not contain results. Nothing here has been measured with a person.

## Before you start

### Start the prototype

1. In `spikes/spike5-form-editor/`, run `npm install` once.
2. Run `npm run serve`. The command prints three addresses.
3. Open an address in a current browser. State is held in memory, so restart the server before each participant to reset it.

Table 1 lists the three sign-ins.

**Table 1. Prototype users**

| User | Level | Can do |
|---|---|---|
| `ed` | Edit data | Open forms and save records |
| `dana` | Design application | Edit a draft and save it, but not publish |
| `mia` | Manage application | Edit, save, and publish |

Use `dana` for the usability session, and `mia` to show publishing afterwards.

### Run it against the backend

To run the session on a real application instead of the synthetic forms, publish an application to the backend and open the editor from it. The steps are in "Edit forms in the browser" in the README. The sign-ins in Table 1 do not apply there: the backend uses the grants you give each user. Give the participant design application, and give yourself manage application, so that you can publish.

Two differences matter for the session. The forms are the real forms of that application, so the task cards in Table 4 need new field names. A reload drops unpublished edits, because the backend keeps no saved draft yet.

### Know the limits

- The forms are synthetic. They are not your Access forms. Replace them with the real forms from Spike 1 before the owner rates fidelity.
- The prototype edits and previews forms. It does not save records to a database.
- The editor supports these edits: add, remove, and move a control, and change a label, a visibility rule, a validation rule, and a default. It also renames a field.

## Part 1: owner's ratings of the rendered forms

### Purpose

Find out whether each rendered form is recognisable and usable, compared with the original in Access. The pass condition in the spike plan is a rating of 4 or 5 for at least 4 of 5 forms.

### Steps

To rate a form:

1. Open the original form in Access.
2. Open the rendered form from the real forms in Spike 1. The five synthetic screenshots are in `docs/spikes/spike-5-screens/` as a reference for the layout style.
3. Compare them side by side.
4. Give the rendered form a rating from 1 to 5, using Table 2.
5. Write down what is missing or different.

**Table 2. Rating scale**

| Rating | Meaning |
|---|---|
| 5 | A user of the Access form could use this form with no help |
| 4 | A user could use it with a short note about what changed |
| 3 | A user could use it, but would be confused for some tasks |
| 2 | A user could not do an important task without help |
| 1 | The form is not recognisable |

### Rating sheet

Copy Table 3 and fill it in.

**Table 3. Rating sheet**

| Form | Rating (1 to 5) | What is missing or different |
|---|---|---|
| Simple form | | |
| Form with a subform | | |
| Form with combo boxes bound to another table | | |
| Form with conditional visibility | | |
| Fifth form of your choice | | |

The condition is met if at least 4 rows score 4 or 5.

## Part 2: usability session

### Purpose

Find out whether three representative users can make the common edits without help. The pass conditions are 80% or more of tasks completed unaided, and a median time under 3 minutes for one task. The owner confirms the 3-minute proposal.

### Choose participants

Pick three people who use Access forms but do not build applications for a living. Plan half a day for each. Do not coach them before the session.

### Run the session

For each participant:

1. Read the introduction aloud: "We are testing the tool, not you. If you get stuck, say what you expected. I will not help unless you ask to stop."
2. Sign the participant in as `dana`.
3. Give the participant one task card at a time, in the order in Table 4.
4. Start a timer when you hand over the card, and stop it when the participant says they are done.
5. Do not help. If the participant is stuck for 5 minutes, record the task as not completed and move on.
6. After the last task, ask the questions under "Closing questions".

### Task cards

Table 4 lists the six tasks. All start from the Customer form unless the card says otherwise.

**Table 4. Task cards**

| No. | Task card | Done when |
|---|---|---|
| 1 | Add the **Customer ID** number to the form, on its own row above **Name**. | A number control for Customer ID appears in the preview, above Name |
| 2 | Hide **Credit limit** unless **Active** is ticked. | The rule is set, and the preview hides Credit limit when Active is unticked |
| 3 | Stop anyone saving a **Credit limit** above 100,000. Show the message "Limit is too high". | A validation rule with that message is saved on Credit limit |
| 4 | Change the label **Name** to **Full name**. | The label reads Full name in the preview |
| 5 | Move **Active** so it sits on its own row, above **Credit limit**. | Active is in its own row, above Credit limit |
| 6 | Make a new product start with the category **Hardware**. Start from the Product form. | A default is set on Category, and the preview shows Hardware |

A participant is **unaided** on a task if they finish without help from the observer and without reading the answer from another source.

### Observation sheet

Copy Table 5 for each participant. Record one row for each task.

**Table 5. Observation sheet**

| Task | Done unaided (yes or no) | Time (minutes and seconds) | Errors and wrong turns | What they said |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |

Count an error when the participant makes a change they did not intend, or sees a "Not changed" message.

### Work out the results

1. **Unaided rate:** divide the number of tasks done unaided, across all participants, by 18. The condition is 80% or more.
2. **Median time:** take the middle time of the 18 task times, counting a task that was not completed as 5 minutes. The proposed condition is under 3 minutes.
3. **Errors:** add up the errors for each task, to find the task that caused the most trouble.

### Closing questions

Ask each participant:

- Which task was hardest, and why?
- What did you look for that you did not find?
- Would you use this instead of changing the form in Access? Why or why not?

## What to do with the results

Table 6 repeats the decision from the spike plan.

**Table 6. Decision**

| Result | Action |
|---|---|
| All measures pass | Adopt the recommended approach in the report, and size the Phase 2 editor from its estimate |
| Usability fails, but the operation model works | Narrow the Phase 2 editor to property-panel editing of fields, labels, and rules, and defer drag-and-drop layout |
| Rendered forms are rated low | Review the scope of form conversion in the PRD |

The report records that the operation model, the rename, and the draft workflow pass without people, so the second row is the likely fallback if usability fails.

## Known usability risks to watch for

The automated tests found three things that a person might trip over. Watch for them in the session:

- **Keyboard route:** the keyboard-only test needed 105 key presses for a seven-step session, because there is no shortcut from the control list to the property panel.
- **Rename preview:** the preview lists what changes and which handlers need review. Check whether participants understand that the data change happens only when the draft is published.
- **Expression syntax:** visibility rules, validation rules, and defaults use text expressions such as `active && credit_limit > 100`. Check whether participants need a builder instead.
- **The empty-field warning:** a validation rule on an optional field warns when it rejects an empty value, and offers a fix. In task 3, check whether the participant sees the warning, understands it, and uses the fix button.
