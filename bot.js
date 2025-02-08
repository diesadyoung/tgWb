require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const winston = require('winston');
const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;


app.get('/', (req, res) => {
  res.send('Telegram Bot is running.');
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});


// Load configuration from environment variables
const token = process.env.TG_TOKEN;
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY_MS) || 5000; // Delay between retries (ms)
const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT_MS) || 30000; // Timeout for page navigation (ms)

// Set up logging with Winston
const logger = winston.createLogger({
  level: 'info',
  transports: [new winston.transports.Console()],
});

// Create a Telegram bot instance with polling
const bot = new TelegramBot(token, { polling: true });

// Global object to keep track of active scraping processes per chat
const scrapingControllers = {};

/**
 * Automatically scrolls down the page to load dynamic content.
 * @param {puppeteer.Page} page - The Puppeteer page instance.
 */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500; // Pixels to scroll each step
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

/**
 * Wraps a promise with a timeout.
 *
 * @param {Promise<any>} promise - The promise to wrap.
 * @param {number} ms - Timeout in milliseconds.
 * @param {string} errorMessage - Message for the timeout error.
 * @returns {Promise<any>}
 */
function withTimeout(promise, ms, errorMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), ms)
    ),
  ]);
}

/**
 * Continuously scrapes the given URL until the target button is found
 * or until a cancellation request is received.
 *
 * @param {string} url - The URL to scrape.
 * @param {Object} cancellationToken - An object with a "cancelled" boolean property.
 * @returns {Promise<Object>} - Resolves with the button data once found.
 * @throws {Error} - Throws an error if scraping is cancelled.
 */
async function scrapeUntilButtonFound(url, cancellationToken) {
    let browser;
    try {
      browser = await puppeteer.launch({ executablePath: '/tmp/puppeteer/chrome/linux-133.0.6943.53/chrome-linux64/chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const page = await browser.newPage();
  
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)'
      );
  
      while (true) {
        if (cancellationToken && cancellationToken.cancelled) {
          logger.info('Scraping cancelled by user.');
          throw new Error('Scraping stopped by user.');
        }
  
        try {
          logger.info(`Navigating to ${url}`);
          await withTimeout(
            page.goto(url, { waitUntil: 'networkidle2' }),
            PAGE_TIMEOUT,
            'Page navigation timed out'
          );
          await new Promise(r => setTimeout(r, 1000));
  
          await autoScroll(page);
          await new Promise(r => setTimeout(r, 2000));
  
          // Modified extraction logic:
          const data = await page.evaluate(() => {
            const button = document.querySelector('.order__button.btn-main');
            if (button) {
              if (button.classList.contains('hide')) {
                return null;
              }
              return {
                text: button.textContent.trim(),
                ariaLabel: button.getAttribute('aria-label'),
                dataLink: button.getAttribute('data-link'),
              };
            }
            return null;
          });
  
          if (data) {
            logger.info('Button found.');
            return data;
          } else {
            logger.info('Button not found or is hidden. Retrying in 5 seconds...');
          }
        } catch (innerError) {
          logger.error(`Error during scraping attempt: ${innerError.message}`);
        }
  
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      }
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
  

// Command Handlers

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    'Hello! I am your Telegram bot. Use /scrape <url> to check the product page.\nUse /stop to cancel an active scrape.'
  );
});

// /scrape command handler
bot.onText(/\/scrape (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1].trim();

  // Basic URL validation
  try {
    new URL(url);
  } catch (err) {
    return bot.sendMessage(chatId, 'Invalid URL provided.');
  }

  // If a scraping process is already active for this chat, inform the user.
  if (scrapingControllers[chatId]) {
    return bot.sendMessage(chatId, 'A scraping process is already running. Use /stop to cancel it before starting a new one.');
  }

  // Create a new cancellation token for this scraping session.
  const cancellationToken = { cancelled: false };
  scrapingControllers[chatId] = cancellationToken;

  logger.info(`Received scraping request for URL: ${url}`);

  try {
    const data = await scrapeUntilButtonFound(url, cancellationToken);
    const message = `Button found!\nText: ${data.text}\nAria Label: ${data.ariaLabel}\nData Link: ${data.dataLink}`;
    bot.sendMessage(chatId, message);
  } catch (error) {
    logger.error('Scraping stopped:', error.message);
    bot.sendMessage(chatId, `Scraping stopped: ${error.message}`);
    console.log(error)
  } finally {
    // Remove the controller whether scraping was successful or cancelled.
    delete scrapingControllers[chatId];
  }
});

// /stop command handler to cancel an active scrape
bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  if (scrapingControllers[chatId]) {
    scrapingControllers[chatId].cancelled = true;
    bot.sendMessage(chatId, 'Scraping has been stopped.');
  } else {
    bot.sendMessage(chatId, 'No active scraping process to stop.');
  }
});

// Graceful shutdown handling
process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully.');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully.');
  bot.stopPolling();
  process.exit(0);
});


