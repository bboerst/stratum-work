# Stratum Work

Stratum Work is a web application that provides real-time visualizations of mining work notifications from Stratum mining pools. It allows users to monitor and analyze the mining activity of various pools in a user-friendly interface. All credit for this idea goes to `0xB10C` and his thread here: https://primal.net/e/note1qckcs4y67eyaawad96j7mxevucgygsfwxg42cvlrs22mxptrg05qtv0jz3. I'm merely copying his idea and putting it into a form where many people can access this data.

## Features

- Real-time display of `mining.notify` messages from Stratum pools
- Customizable table columns for displaying relevant data
- Light and dark mode
- Live and historical data views (historical view coming soon)
- Integration with RabbitMQ for efficient message processing
- MongoDB integration for data storage and retrieval (future)
- Most 'work' is done server-side to keep the browser performant

## Installation

This a bit of a complex architecture to replicate, but if you want to recreate this, at a high-level it looks like this:

- Kubernetes StatefulSet pods individually connect to a list of pools. One pod per pool.
- These pods listen for `mining.notify` Stratum messages. Once receives, they are sent to MongoDB for archival and a RabbitMQ exchange
- The RabbitMQ portion is configured with an exchange + fanout
- The server-side web application uses Flask, gunicorn with eventlet, and socket.io. As clients connect, they get subscribed to the RabbitMQ exchange. A websocket sends realtime updates to the client.