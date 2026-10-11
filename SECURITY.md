# Security and privacy

TokenDesk communicates locally between the Chrome extension and the macOS app over `127.0.0.1:18743` using a pairing key.

The project is intended to send only normalized quota data to the local Mac app. Browser login credentials, cookies, chat contents, and authorization tokens are not sent to the Mac app.

Because the Chrome extension accesses ChatGPT web endpoints using the browser's logged-in session, review the source before installing if you have security concerns.

This is an unofficial project and is not affiliated with OpenAI.


## Running-task monitor

v1.7.0 detects active ChatGPT web tasks from open Chrome tabs. For this feature, TokenDesk sends only the page title, page URL, active/inactive state, and timing metadata to the local Mac app. Chat message text is not transmitted.
