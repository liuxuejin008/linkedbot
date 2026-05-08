# Cloudflare Email Routing Setup Guide

> 📖 [中文版本 → EMAIL_SETUP.zh.md](./EMAIL_SETUP.zh.md)

Using Cloudflare's Email Routing feature, you can enable LinkedBot to receive emails sent to your custom channels. By enabling the "Catch-all" feature, you can dynamically receive emails with any prefix **without having to create each email address manually in the dashboard**.

## 🌟 What is Catch-all?

When initially setting up Cloudflare Email Routing, the system requires you to create a specific test address (e.g., `test@yourdomain.com`). However, for LinkedBot, we want the system to automatically handle emails sent to different channel prefixes (e.g., `alert@yourdomain.com`, `my-bot@yourdomain.com`).

Once **Catch-all** is enabled, any email sent to **any** prefix under your domain will be captured and sent directly to our Worker for automatic parsing and distribution.

---

## 🛠️ Detailed Setup Steps

### Step 1: Complete Basic DNS Setup
If this is your first time using Email Routing for this domain:
1. Log in to the Cloudflare dashboard and go to your domain management page.
2. Click **Email** -> **Email Routing** in the left menu.
3. Follow the initialization guide on the page. The system will guide you to add the necessary DNS records and require you to create a basic test routing address. Please complete this step first.

### Step 2: Enable Catch-all and Point to Worker
Once the basic setup is complete, follow these steps to enable the Catch-all feature:
1. Still on the **Email Routing** page, click the **Routing Rules** tab at the top.
2. Scroll down to find the **Catch-all address** module.
3. Click the edit button on the right and ensure the status is **Enabled**.
4. Critical settings:
   - **Action**: Select **Send to a Worker**.
   - **Destination**: From the dropdown menu, select your deployed LinkedBot Worker (usually named `linkedbot`).
5. Click **Save**.

🎉 **Setup Complete!**

---

## 🚀 How It Works & Testing

Now, your Cloudflare email system has fully taken over the domain. You can try sending a test email from your personal account to:
👉 `anything@yourdomain.com` (Replace with your actual domain)

**What happens next?**
1. When the email reaches Cloudflare, it is captured by the Catch-all rule.
2. Cloudflare passes the full content of the email (including sender, subject, body, etc.) to the LinkedBot Worker.
3. The Worker automatically extracts the prefix before the `@` (e.g., `anything`) and searches for a channel with that prefix in the database.
4. If a match is found, the email is instantly pushed to your configured intranet receiver!
