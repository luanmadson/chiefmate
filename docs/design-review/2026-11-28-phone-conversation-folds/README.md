# Design review: the conversation fills a phone's screen

The **Conversation**, with made-up data: the manager answering, three messages of yours waiting in the queue, one notice of the Conversation (an update blocked, important) and two of other sections (Operations, urgent; Planning, important). Captured in headless Edge at 390×844 with touch (phone), interface in Brazilian Portuguese. The app has one theme, dark. The numbers are the height left to the conversation's messages.

| Screen | What to check |
|---|---|
| [Before](before-phone-pt-BR.png) | 100 px of conversation: the queue takes 270 px, and the conversation stops short of its end (the manager's answer under way is out of view). |
| [Before, focus mode](before-phone-focus-pt-BR.png) | 304 px: the same queue; the line on top has no mark for the Conversation's own notice. |
| [After](after-phone-pt-BR.png) | 335 px. The queue is one line: **3 NA FILA**, why they wait, **Ver todos ▾**. The conversation opens at its end (the answer under way and **Última ação**). The arrow beside **Nova** minimizes the header. |
| [After, focus mode](after-phone-focus-pt-BR.png) | 539 px. On the line on top, a section for each mark, the Conversation's own included; the names give way (cut short) so no mark scrolls out of the line. **Sair** (the short **Sair do foco**) and the arrow that minimizes it. |
| [Header minimized](after-phone-header-folded-pt-BR.png) | 459 px. The title bar, the notice and the header become one thin line: the manager's state (**Pensando…**), the notice's mark in its color and **▾**. A tap on the line brings them back. The bottom bar keeps the other sections' marks. |
| [Header minimized, focus mode](after-phone-focus-header-folded-pt-BR.png) | 558 px. The same thin line, with the marks of the sections that need you (important, urgent, important). |
| [Queue opened, focus mode](after-phone-focus-queue-open-pt-BR.png) | A tap on the queue's line opens the messages, with **Editar** and **Remover**, under **Ocultar ▴**; the line stays on top while the list scrolls. |

Each choice (header, queue) is kept on the phone; the queue starts folded. On a computer nothing changes but the Conversation's mark on the focus mode's line. Not captured: the keyboard open (the thin line steps aside, like the header did, and only the conversation, the queue's line and the field stay), the lockdown's red band and a call's bar (it reached main after these captures): neither folds, and both stay above the thin line, which then leaves them the phone's top inset.
