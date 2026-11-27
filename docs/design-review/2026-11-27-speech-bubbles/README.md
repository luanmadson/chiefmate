# Design review: speech bubbles

Made-up data: three projects with a run going on in each. Webshop: the generalist redoes a pull request the manager asked for and says what it is doing. Blog: a mission whose writer finished its part and whose curator waits for the owner. Docs: the designer has said nothing and shows its automatic line, stuck after 25 minutes without an action. Captured in headless Edge at 1440×1000 (computer) and 390×844 (phone, emulated), interface in Brazilian Portuguese. The app has one theme, dark: there is no light theme to capture.

| Screen | Computer | Phone | What to check |
|---|---|---|---|
| Operations | [operations](operations-desktop.png) | [operations](operations-phone.png) | On each run's card, under its title, a bubble with a tail toward the agent's face: the line, its state in a word and the color of the left rule (blue working, amber waiting), the time and, for a line Chiefmate wrote, **automático**. In "Equipe a bordo", one bubble per member at work; the writer, done with its part, in grey. |
| Crew | [crew](crew-desktop.png) | [crew](crew-phone.png) | The bubble under "Em: …" on each card: working, waiting, stuck (red) and part done (quiet). On the phone, the text is 15 px and wraps to three lines at most. |
| A project's crew | [blog crew](project-crew-desktop.png) | [blog crew](project-crew-phone.png) | Only that project's runs: the writer's last line (part done, grey) and the curator's request, in amber. The members with nothing going on have no bubble. |
| A project's tasks | [webshop tasks](project-tasks-desktop.png) | | The run going on shows the bubble in place of the old "Agora: …" line. |
| History | [history](history-desktop.png) | [history](history-phone.png) | A click on a bubble: "Falas da equipe", the run and its project, the lines newest first, each with the member's name and role, the time and, when it says something new, its state; "Chiefmate (Gerente) pediu: …" for the task the manager queued. |

Not captured: a line the owner wrote from the agent's panel ("Você pediu: …"), drawn like the manager's; and **Chamando você**, the state of a step that waits for the owner (added in the manager's review: the urgent red, a tinted bubble and its mark pulsing as the urgent notices do).
