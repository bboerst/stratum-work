# Stratum Work

Stratum Work is a web application that provides real-time visualizations of mining work notifications from Stratum mining pools. It allows users to monitor and analyze the mining activity of various pools in a user-friendly interface. All credit for this idea goes to `0xB10C` and his thread here: https://primal.net/e/note1qckcs4y67eyaawad96j7mxevucgygsfwxg42cvlrs22mxptrg05qtv0jz3. I'm merely copying his idea and putting it into a form where many people can access this data.

## Architecture Overview

Stratum Work consists of three main components:

1. **Collector**: Connects to Bitcoin mining pools via the Stratum protocol, captures `mining.notify` messages, and forwards them to RabbitMQ.
2. **Backend**: Processes Bitcoin blocks, identifies mining pools, and provides block data to the web application.
3. **Web Application**: Displays real-time mining notifications and block information in an interactive interface.

### Data Flow

1. Multiple collector instances connect to different mining pools
2. When a pool sends a `mining.notify` message, the collector:
   - Stores the message in MongoDB
   - Publishes the message to RabbitMQ
3. The web application consumes these messages from RabbitMQ and displays them in real-time
4. The backend processes new blocks from a Bitcoin node and identifies which pool mined each block

## Technical Details

### Stratum Protocol and Mining.Notify Messages

The Stratum protocol is used by mining pools to coordinate miners. The `mining.notify` message is particularly important as it contains the template for a new block that miners should work on. Each message contains:

- **Job ID**: A unique identifier for this mining job
- **Previous Block Hash**: The hash of the last block in the chain
- **Coinbase (Part 1 & 2)**: The coinbase transaction split into two parts
- **Merkle Branches**: Hashes needed to construct the merkle root
- **Version**: Block version
- **nBits**: Target difficulty
- **nTime**: Current timestamp
- **Clean Jobs**: Boolean indicating if previous jobs should be discarded

### Trustless Data Processing

A key design principle of Stratum Work is **trustless data processing**. While the server collects and streams the raw data, **all decoding, formatting, and visualization is performed in the client browser**.

### Raw Data

The application provides a Server-Sent Events (SSE) endpoint:

```
GET /api/stream
```

This endpoint delivers the same real-time data that powers the web interface, allowing for custom integrations or alternative visualizations.

### Data Processing and Visualization

#### Collector Processing

The collector performs minimal processing to maintain data integrity:

See [collector/main.py:294-323](collector/main.py#L294-L323) for the notification document creation function.

#### Web Application Processing

The web application performs extensive processing to make the data more readable and visually informative:

1. **Coinbase Transaction Reconstruction**:  
   See [web/utils/formatters.ts:38-45](web/utils/formatters.ts#L38-L45)

2. **Coinbase Script ASCII Extraction**:  
   See [web/utils/bitcoinUtils.ts:48-76](web/utils/bitcoinUtils.ts#L48-L76)

3. **Coinbase Output Analysis**:  
   See [web/utils/bitcoinUtils.ts:95-126](web/utils/bitcoinUtils.ts#L95-L126)

4. **First Transaction Extraction**:  
   See [web/utils/bitcoinUtils.ts:129-139](web/utils/bitcoinUtils.ts#L129-L139)

5. **Fee Rate Calculation**:  
   See [web/utils/bitcoinUtils.ts:142-168](web/utils/bitcoinUtils.ts#L142-L168)

### Backend Block Processing

The backend identifies which pool mined each block by analyzing the coinbase transaction:

See [backend/main.py:815-890](backend/main.py#L815-L890) for the block processing function.

## Features

- Real-time display of `mining.notify` messages from Stratum pools
- Customizable table columns for displaying relevant data
- Light and dark mode
- Live and historical data views (historical view coming soon)
- Integration with RabbitMQ for efficient message processing
- MongoDB integration for data storage and retrieval
- Most 'work' is done client-side for trustless data processing
- Raw data access via `/api/stream` endpoint

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