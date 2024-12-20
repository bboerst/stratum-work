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

## Local Development with Docker-Compose

To simplify local development and testing, you can use `docker-compose` to run all the components on your machine. This allows you to quickly spin up RabbitMQ, MongoDB, a web application container, and one or more collector containers.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)

### Steps

1. **Clone the repository**:
   ```bash
   git clone https://github.com/bboerst/stratum-work.git
   cd stratum-work
   ```
2. **Customize collectors**:

    In the `./docker-compose.yml` file, you will see a collector-base service along with one or more collectors (e.g., collector-f2pool). Each collector points to a specific Stratum pool. To add more pools, just duplicate one of the collector services and update the --pool-name and --url fields:
   ```bash
   collector-newpool:
     <<: *collector-base
     command: >
         /usr/local/bin/python main.py
         --pool-name "NewPool"
         --url "stratum+tcp://newpool.com:3333"
         --userpass "someuser:somepass"
         --rabbitmq-host "rabbitmq"
         --rabbitmq-username "mquser"
         --rabbitmq-password "mqpassword"
         --db-url "mongodb"
         --db-name "stratum-logger"
         --db-username "mongouser"
         --db-password "mongopassword"
         --log-level "DEBUG"
   ```
   The <<: *collector-base line pulls in all the shared environment variables and dependencies. All you need to do is adjust pool-specific configuration.

3. **Build and start the services**:
   ```bash
   docker-compose up --build
   ```
   This command will:
	- Build the images for the webapp and collector services.
	- Start RabbitMQ, MongoDB, and your configured collectors.
	- Start the web application.

    Once everything is running, the web application should be accessible at http://localhost:8000.

4. **View Logs**:

    As everything starts, you can see logs in the terminal where you ran docker-compose up.These logs will show connections to pools,RabbitMQ events, and requests to the webapp.

5. **Stop the services**:

    To stop and remove the containers, press `Ctrl + C` in your terminal. To remove containers, networks, and images created by docker-compose, run:

    ```bash
    docker-compose down
    ```

    To also remove the mongodb volume:
    ```bash
    docker-compose down -v
    ```