import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export const sendEmail = async (to, subject, html) => {
  try {
    const response = await resend.emails.send({
      from: 'onboarding@resend.dev', // Replace with your verified sender email
      to,
      subject,
      html,
    });
    console.log('Email sent successfully:', response);
    return response;
  } catch (error) {
    console.error('Error sending email with Resend:', error);
    throw error; // Re-throw error for handling by the caller
  }
};