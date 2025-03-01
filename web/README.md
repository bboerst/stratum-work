# Stratum Work Visualization

A modern web application for visualizing Stratum v1 mining.notify events from multiple Bitcoin mining pools in real-time. This application helps users compare and analyze work coming from different mining pools through intuitive visualizations.

## Overview

Stratum Work Visualization collects and displays real-time data from various Bitcoin mining pools using the Stratum protocol. The application provides:

- Real-time visualization of mining.notify events
- Comparative analysis of work across multiple pools
- Interactive data tables with customizable columns
- Sankey diagram visualization for work distribution
- Dark and light mode support

## Features

- **Real-time Data**: Live streaming of mining.notify events from multiple pools
- **Customizable Table View**: Sort, filter, and customize columns to focus on relevant data
- **Sankey Diagram**: Visualize the flow of work across different mining pools
- **Responsive Design**: Works on desktop and mobile devices
- **Theme Support**: Toggle between light and dark modes

## Technology Stack

- **Frontend**: Next.js, React, TypeScript, Tailwind CSS
- **Data Visualization**: Custom React components
- **Real-time Communication**: WebSockets for live data updates
- **Backend Integration**: Connects to a collector service that interfaces with mining pools

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the application.

## Pages

- **Table View**: `/table` - Detailed tabular view of mining.notify events

## Architecture

This web application is part of a larger system that includes:

1. **Collectors**: Python-based services that connect to mining pools via the Stratum protocol
2. **Message Queue**: RabbitMQ for efficient message processing
3. **Database**: MongoDB for data storage and retrieval
4. **Web Application**: This Next.js application for visualization

## Development

This project uses:

- [Next.js](https://nextjs.org/) for the React framework
- [Tailwind CSS](https://tailwindcss.com/) for styling
- [TypeScript](https://www.typescriptlang.org/) for type safety
- [Geist Font](https://vercel.com/font) for typography

## Learn More

To learn more about the technologies used:

- [Next.js Documentation](https://nextjs.org/docs)
- [Stratum Mining Protocol](https://braiins.com/stratum-v1/docs)
- [Bitcoin Mining](https://developer.bitcoin.org/devguide/mining.html)

## Deployment

The application can be deployed using Docker or directly on platforms like Vercel:

```bash
# Build the Docker image
docker build -t stratum-work-web .

# Run the container
docker run -p 3000:3000 stratum-work-web
```

For more deployment options, see the main project README.
