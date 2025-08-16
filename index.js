require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripeLib = require('stripe');
const jwt = require('jsonwebtoken');
const admin = require("firebase-admin");


const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://my-school-b2c91.web.app',
    'https://b11a12-server-side-tawhide16.vercel.app' // এখানে তোর নতুন deploy করা URL বসাও
  ],
  credentials: true,
}));
app.use(express.json());



const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decodedKey);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


// ✅ Middleware to verify Firebase token
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send({ message: "Unauthorized" });

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).send({ message: 'unauthorize token' })
  }

  //verify token 
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded = decoded;
    next()
  }
  catch {
    return res.status(403).send({ message: 'forbidden token' })
  }
};

// MongoDB URI & Client Setup
const uri = `mongodb+srv://${process.env.USER_DB}:${process.env.PASS_DB}@cluster0.bw3blcg.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const stripe = stripeLib(process.env.STRIPE_SECRET_KEY);

async function run() {
  try {
    // Connect to MongoDB
    // await client.connect();
    console.log("✅ MongoDB connected!");

    const db = client.db("eduManage");

    // Collections
    const userCollection = db.collection("users");
    const teacherCollection = db.collection("teachers");
    const enrollmentCollection = db.collection("enrollments");
    const classCollection = db.collection("classes");
    const assignmentCollection = db.collection("assignments");
    const submissionsCollection = db.collection("submissions");
    // const feedbacks = db.collection("feedbacks");


    app.post('/jwt', (req, res) => {
      const { email } = req.body;
      if (!email) return res.status(400).json({ message: 'Email is required' });

      const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '7d' });
      res.json({ token });
    });
    // Routes:
    // Root
    app.get('/', (req, res) => {
      res.send('Hello from EduManage Server!');
    });

    // Get all enrollments (payment history) by student email
    app.get('/api/enrollments/history/:studentEmail', verifyFirebaseToken, async (req, res) => {
      try {
        const { studentEmail } = req.params;
        if (!studentEmail) return res.status(400).json({ message: 'Missing studentEmail parameter' });

        const enrollments = await enrollmentCollection.find({ studentEmail }).toArray();
        res.json(enrollments);
      } catch (err) {
        console.error('Error fetching enrollment history:', err);
        res.status(500).json({ message: 'Server error' });
      }
    });

    // Get all enrollments (all students)
    app.get('/api/enrollments/history', async (req, res) => {
      try {
        const enrollments = await enrollmentCollection.find().toArray();
        // Ensure every document has paymentStatus & enrolledAt
        const safeEnrollments = enrollments.map(e => ({
          ...e,
          paymentStatus: e.paymentStatus || "unpaid",
          enrolledAt: e.enrolledAt || new Date().toISOString(),
          price: e.price || 0
        }));
        res.json(safeEnrollments);
      } catch (err) {
        console.error('Error fetching all enrollment history:', err);
        res.status(500).json({ message: 'Server error' });
      }
    });

    // Create Stripe payment intent
    app.post('/api/create-payment-intent', async (req, res) => {
      try {
        const { price } = req.body;
        if (!price) return res.status(400).json({ message: 'Price is required' });

        const amount = Math.round(price * 100);
        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: 'usd',
          payment_method_types: ['card'],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        console.error('Stripe payment intent error:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // Check if student is enrolled in a class
    app.get('/api/enrollments', async (req, res) => {
      try {
        const { studentEmail, classId } = req.query;
        if (!studentEmail || !classId) return res.status(400).json({ message: 'Missing studentEmail or classId query parameter' });

        const enrollment = await enrollmentCollection.findOne({ studentEmail, classId });
        res.json(enrollment ? [enrollment] : []);
      } catch (err) {
        console.error('Error fetching enrollment:', err);
        res.status(500).json({ message: 'Server error' });
      }
    });

    app.get('/api/my-enrollments', verifyFirebaseToken, async (req, res) => {
      const studentEmail = req.query.studentEmail;

      if (!studentEmail) {
        return res.status(400).json({ error: 'ইমেইল পাওয়া যায়নি' });
      }

      try {
        const enrollments = await db
          .collection('enrollments')
          .find({ studentEmail })
          .toArray();

        res.send(enrollments);
      } catch (error) {
        console.error('Enrollment লোড করতে সমস্যা:', error);
        res.status(500).json({ error: 'সার্ভার সমস্যা হয়েছে' });
      }
    });


    // Get teacher details by email
    app.get("/api/users/teacher-details/:email", async (req, res) => {
      try {
        const email = decodeURIComponent(req.params.email);
        const teacher = await userCollection.findOne({ email, role: "teacher" });

        if (!teacher) {
          return res.status(404).send({ message: "Teacher not found" });
        }

        res.send({
          name: teacher.name,
          image: teacher.image,
          email: teacher.email,
          experience: teacher.experience,
        });
      } catch (err) {
        console.error("Teacher details fetch failed:", err.message);
        res.status(500).send({ error: "Internal server error" });
      }
    });

    // Get teacher application status by email
    
    app.get('/api/teachers/status/:email', async (req, res) => {
      try {
        const email = decodeURIComponent(req.params.email);
        if (!email) {
          return res.status(400).json({ status: null, message: "Email is required" });
        }

        const teacher = await teacherCollection.findOne({ email });

        if (!teacher) {
          return res.status(404).json({ status: null });
        }

        res.json({ status: teacher.status });
      } catch (err) {
        console.error("Error fetching teacher status:", err);
        res.status(500).json({ error: "Internal server error" });
      }
    });







    app.post("/api/users", async (req, res) => {
      try {
        const { name, email, image, role } = req.body;

        if (!email) {
          return res.status(400).send({ error: "Email is required" });
        }

        const existingUser = await userCollection.findOne({ email });
        if (existingUser) {
          return res.status(200).send({ message: "User already exists" });
        }

        const newUser = {
          name: name || "Unknown",
          email,
          image: image || "https://i.ibb.co/4pDNDk1/avatar.png",
          role: role || "student",
          createdAt: new Date(),
        };

        await userCollection.insertOne(newUser);
        res.status(201).send({ message: "User saved successfully" });
      } catch (err) {
        console.error("User save failed:", err.message);
        res.status(500).send({ error: "Internal server error" });
      }
    });

    // Add new user
    app.post('/api/users', async (req, res) => {
      try {
        const user = req.body;
        if (!user.email) return res.status(400).json({ message: 'Email is required' });

        const exists = await userCollection.findOne({ email: user.email });
        if (exists) return res.status(409).json({ message: 'User already exists' });

        const result = await userCollection.insertOne(user);
        res.status(201).json({ message: 'User created successfully', insertedId: result.insertedId });
      } catch (err) {
        console.error('User creation error:', err);
        res.status(500).json({ message: 'Server error', error: err.message });
      }
    });

    // Get single user by email
    app.get('/api/users/:email', async (req, res) => {
      try {
        const email = req.params.email;
        const user = await userCollection.findOne({ email });
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
      } catch (err) {
        console.error('Get user error:', err);
        res.status(500).json({ message: 'Server error' });
      }
    });

    // Submit Teacher Application
    app.post('/api/teachers', async (req, res) => {
      try {
        const teacher = req.body;
        teacher.status = 'pending';
        const result = await teacherCollection.insertOne(teacher);
        res.status(201).json({ message: 'Teacher application submitted', insertedId: result.insertedId });
      } catch (err) {
        console.error('Teacher application error:', err);
        res.status(500).json({ message: 'Failed to submit application', error: err.message });
      }
    });

    // Get all teacher requests
    app.get('/api/teachers', async (req, res) => {
      try {
        const teachers = await teacherCollection.find().toArray();
        res.json(teachers);
      } catch (err) {
        console.error('Get teachers error:', err);
        res.status(500).json({ message: 'Server error' });
      }
    });

    // Update teacher status
    app.patch('/api/teachers/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        const result = await teacherCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );
        res.json({ message: 'Teacher status updated', result });
      } catch (err) {
        console.error('Update teacher status error:', err);
        res.status(500).json({ message: 'Failed to update teacher status', error: err.message });
      }
    });

    // Check if user is teacher
    app.get('/api/users/teacher/:email', async (req, res) => {
      try {
        const email = req.params.email;
        const user = await userCollection.findOne({ email });
        res.json({ teacher: user?.role === 'teacher' });
      } catch (err) {
        console.error('Check teacher role error:', err);
        res.status(500).json({ message: 'Failed to check teacher role', error: err.message });
      }
    });

    // Update user role
    app.patch('/api/users/role/:email', async (req, res) => {
      try {
        const { email } = req.params;
        const { role } = req.body;

        const result = await userCollection.updateOne(
          { email },
          { $set: { role } }
        );
        res.json({ message: 'User role updated', result });
      } catch (err) {
        console.error('Update user role error:', err);
        res.status(500).json({ message: 'Failed to update user role', error: err.message });
      }
    });

    // Check if user is admin
    app.get('/api/users/admin/:email', async (req, res) => {
      try {
        const email = req.params.email;
        const user = await userCollection.findOne({ email });
        res.json({ admin: user?.role === 'admin' });
      } catch (err) {
        console.error('Admin check error:', err);
        res.status(500).json({ message: 'Failed to check admin role', error: err.message });
      }
    });

    // Search users
    app.get('/api/users', async (req, res) => {
      try {
        const { search } = req.query;
        const query = {};
        if (search) {
          query.$or = [
            { name: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
          ];
        }
        const users = await userCollection.find(query).toArray();
        res.json(users);
      } catch (err) {
        console.error('User search error:', err);
        res.status(500).json({ message: 'Server error' });
      }
    });

    // Promote user to admin
    app.patch('/api/users/admin/:email', async (req, res) => {
      try {
        const email = req.params.email;
        const result = await userCollection.updateOne(
          { email },
          { $set: { role: 'admin' } }
        );
        res.json({ message: 'User promoted to admin', result });
      } catch (err) {
        console.error('Promote admin error:', err);
        res.status(500).json({ message: 'Failed to promote user', error: err.message });
      }
    });

    // ✅ Remove Admin
    app.patch('/api/users/remove-admin/:email', async (req, res) => {
      const email = req.params.email;
      try {
        const result = await userCollection.updateOne(
          { email: email },
          { $set: { role: 'user' } }
        );

        if (result.modifiedCount === 0) {
          return res.status(404).json({ message: 'User not found or already a normal user' });
        }

        res.json({ message: 'Admin role removed successfully!' });
      } catch (err) {
        console.error('Remove admin error:', err);
        res.status(500).json({ message: 'Failed to remove admin' });
      }
    });


    // Add class
    app.post('/api/classes', verifyFirebaseToken, async (req, res) => {
      try {
        const newClass = req.body;
        newClass.status = 'pending';
        newClass.totalEnrolled = 0;

        const result = await classCollection.insertOne(newClass);
        res.status(201).json({ message: 'Class submitted', insertedId: result.insertedId });
      } catch (err) {
        console.error('Add class error:', err);
        res.status(500).json({ message: 'Failed to submit class', error: err.message });
      }
    });

    // Get classes by teacher email
    app.get('/api/classes', async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ message: 'Email query parameter is required' });

        const classes = await classCollection.find({ email }).toArray();
        res.json(classes);
      } catch (err) {
        console.error('Get classes error:', err);
        res.status(500).json({ message: 'Server error' });
      }
    });

    // Update class
    app.patch('/api/classes/:id', verifyFirebaseToken, async (req, res) => {
      try {
        const { id } = req.params;
        const updatedData = req.body;

        console.log("Received ID:", id);
        console.log("Update Payload:", updatedData);

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: 'Invalid ID' });
        }

        const result = await classCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedData }
        );

        console.log("Update result:", result);

        res.json({ message: 'Class updated', result });
      } catch (err) {
        console.error('Update class error:', err);
        res.status(500).json({ message: 'Update failed', error: err.message });
      }
    });


    // Delete class
    app.delete('/api/classes/:id', verifyFirebaseToken, async (req, res) => {
      try {
        const { id } = req.params;
        const result = await classCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) return res.status(404).json({ message: 'Class not found' });

        res.json({ message: 'Class deleted successfully' });
      } catch (err) {
        console.error('Delete class error:', err);
        res.status(500).json({ message: 'Server error while deleting class' });
      }
    });

    // Get all classes for admin
    app.get('/api/classes/all', async (req, res) => {
      try {
        const classes = await classCollection.find().toArray();
        res.json(classes);
      } catch (err) {
        console.error('Get all classes error:', err);
        res.status(500).json({ message: 'Failed to fetch classes', error: err.message });
      }
    });

    // Get only approved classes
    // Example with native MongoDB driver
    app.get('/api/classes/approved', async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const filter = { status: 'approved' };

        const totalItems = await db.collection('classes').countDocuments(filter);

        const data = await db
          .collection('classes')
          .find(filter)
          .sort({ enrolledCount: -1 }) // 👈 SORT BY HIGHEST ENROLLED
          .skip(skip)
          .limit(limit)
          .toArray();

        const totalPages = Math.ceil(totalItems / limit);

        res.json({
          data,
          totalItems,
          totalPages,
          currentPage: page,
        });
      } catch (error) {
        console.error('❌ Error getting approved classes:', error);
        res.status(500).json({ message: 'Server error' });
      }
    });

    const { ObjectId } = require('mongodb');

    app.get('/api/classes/top-enrolled', async (req, res) => {
      try {
        const pipeline = [
          {
            $match: { status: 'approved' } // only approved classes
          },
          {
            $lookup: {
              from: 'enrollments',
              localField: '_id',
              foreignField: 'classId',
              as: 'enrollments'
            }
          },
          {
            $addFields: {
              totalEnrolled: { $size: '$enrollments' }
            }
          },
          {
            $sort: { totalEnrolled: -1 } // sort by most enrolled
          },
          {
            $limit: 4 // return top 4
          },
          {
            $project: {
              enrollments: 0 // don't send full enrollment array, just count
            }
          }
        ];

        const topClasses = await db.collection('classes').aggregate(pipeline).toArray();
        res.json(topClasses);
      } catch (error) {
        console.error('Error in /api/classes/top-enrolled:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });


    // Add assignment
    app.post('/api/assignments', verifyFirebaseToken, async (req, res) => {
      try {
        const { classId, title, deadline, description } = req.body;
        if (!classId || !title || !deadline || !description)
          return res.status(400).json({ message: 'Missing required fields' });

        const result = await assignmentCollection.insertOne({
          classId,
          title,
          deadline,
          description,
          createdAt: new Date(),
        });
        res.status(201).json({ message: 'Assignment created', id: result.insertedId });
      } catch (err) {
        console.error('Add assignment error:', err);
        res.status(500).json({ message: 'Failed to create assignment', error: err.message });
      }
    });

    // Get assignments by classId
    app.get('/api/assignments', async (req, res) => {
      try {
        const { classId } = req.query;
        if (!classId) return res.status(400).json({ message: 'Missing classId query parameter' });

        const assignments = await assignmentCollection.find({ classId }).toArray();
        res.json(assignments);
      } catch (err) {
        console.error('Get assignments error:', err);
        res.status(500).json({ message: 'Server error' });
      }
    });

    app.post("/api/assignments", async (req, res) => {
      const assignment = req.body;

      if (!assignment?.title || !assignment?.description || !assignment?.deadline || !assignment?.classId || !assignment?.image) {
        return res.status(400).send({ error: "Missing required fields" });
      }

      const result = await db.collection("assignments").insertOne(assignment);
      res.send(result);
    });

    // ⬇️ এইখানে বসা ঠিক হবে!
    // Get submitted assignments by classId
    app.get('/api/assignments/submitted/:classId', verifyFirebaseToken, async (req, res) => {
      const { classId } = req.params;
      try {
        const submissions = await db
          .collection('assignments') // ✅ fixed this line
          .find({ classId })         // adjust this if classId is ObjectId
          .toArray();

        if (submissions.length === 0) {
          return res.status(404).json({ message: "কোনো সাবমিশন পাওয়া যায়নি" });
        }

        res.json(submissions);
      } catch (err) {
        console.error('Submission fetch error:', err);
        res.status(500).json({ error: "সার্ভারে সমস্যা হয়েছে" });
      }
    });

    // Count assignments by classId
    app.get('/api/assignments/count/:classId', async (req, res) => {
      const { classId } = req.params;
      try {
        const count = await db
          .collection('assignments')
          .countDocuments({ classId }); // যদি classId string হিসেবেই থাকে

        res.json({ count });
      } catch (err) {
        console.error('Assignment count fetch error:', err);
        res.status(500).json({ message: 'Failed to fetch assignment count' });
      }
    });

    app.post('/api/submit-assignment', verifyFirebaseToken, async (req, res) => {
      try {
        const { assignmentId, classId, studentEmail, submissionText, submittedAt } = req.body;

        if (!assignmentId || !classId || !studentEmail || !submissionText) {
          return res.status(400).json({ error: "Missing required fields" });
        }

        const submission = {
          assignmentId,
          classId,
          studentEmail,
          submissionText,
          submittedAt: new Date(submittedAt),
        };

        const result = await db.collection('submissions').insertOne(submission);

        res.status(201).json({ message: 'Assignment submitted successfully', id: result.insertedId });
      } catch (error) {
        console.error('Submission error:', error);
        res.status(500).json({ error: 'Failed to submit assignment' });
      }
    });

    app.get('/api/assignments/submitted/:classId', async (req, res) => {
      try {
        const { classId } = req.params;
        const submissions = await db.collection('submissions').find({ classId }).toArray();

        if (submissions.length === 0) {
          return res.status(404).json({ message: 'No submissions found' });
        }

        res.json(submissions);
      } catch (error) {
        console.error('Error fetching submissions:', error);
        res.status(500).json({ error: 'Server error' });
      }
    });

    app.get('/api/enrollments/count/:classId', async (req, res) => {
      const { classId } = req.params;

      try {
        const count = await enrollmentCollection.countDocuments({ classId });
        res.json({ count });
      } catch (err) {
        console.error('Enrollment count fetch error:', err);
        res.status(500).json({ message: 'Server error' });
      }
    });

    // Get single class by id
    app.get('/api/classes/:id', async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: 'Invalid class ID' });
        }

        const classData = await classCollection.findOne({ _id: new ObjectId(id) });
        if (!classData) {
          return res.status(404).json({ message: 'Class not found' });
        }

        res.json(classData);
      } catch (err) {
        console.error('Get single class error:', err);
        res.status(500).json({ message: 'Server error' });
      }
    });

    // Enrollment save করার জন্য POST রুট
    app.post('/api/enroll', verifyFirebaseToken, async (req, res) => {
      try {
        const enrollment = req.body;

        if (!enrollment.studentEmail || !enrollment.classId) {
          return res.status(400).json({ message: 'Required fields missing' });
        }

        // একবার চেক করে নে, ওই স্টুডেন্ট আগেই এনরোলড কিনা
        const exists = await enrollmentCollection.findOne({
          studentEmail: enrollment.studentEmail,
          classId: enrollment.classId,
        });

        if (exists) {
          return res.status(409).json({ message: 'Already enrolled' });
        }

        const result = await enrollmentCollection.insertOne(enrollment);
        res.status(201).json({ message: 'Enrollment successful', insertedId: result.insertedId });
      } catch (err) {
        console.error('Enrollment save error:', err);
        res.status(500).json({ message: 'Server error', error: err.message });
      }
    });

    // server/routes/assignments.js অথবা index.js যেখানে assignment রাউট আছে
    app.patch('/api/assignments/increment-submission/:id', async (req, res) => {
      const assignmentId = req.params.id;

      try {
        const result = await assignmentCollection.updateOne(
          { _id: new ObjectId(assignmentId) },
          { $inc: { submissionCount: 1 } }
        );

        if (result.modifiedCount > 0) {
          res.send({ success: true, message: 'Submission count incremented.' });
        } else {
          res.status(404).send({ success: false, message: 'Assignment not found.' });
        }
      } catch (err) {
        console.error(err);
        res.status(500).send({ success: false, message: 'Server error.' });
      }
    });

    app.get('/api/assignments/submissions/count/:classId', async (req, res) => {
      const classId = req.params.classId;
      try {
        const count = await submissionsCollection.countDocuments({ classId });
        res.json({ totalSubmissions: count });
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
      }
    });

    // 📦 Add this inside your run() function
    app.get('/api/stats', async (req, res) => {
      try {
        const totalUsers = await userCollection.estimatedDocumentCount();
        const totalClasses = await classCollection.estimatedDocumentCount();
        const totalEnrollments = await enrollmentCollection.estimatedDocumentCount();

        res.json({ totalUsers, totalClasses, totalEnrollments });
      } catch (err) {
        console.error("Stats fetch error:", err);
        res.status(500).json({ message: "Failed to fetch stats" });
      }
    });

    // POST /api/teaching-evaluations
    app.post('/api/feedback', verifyFirebaseToken, async (req, res) => {
      try {
        const { studentEmail, classId, description, rating, createdAt, image } = req.body;

        if (!studentEmail || !classId || !description || !rating) {
          return res.status(400).json({ message: 'Missing required fields' });
        }

        const feedback = {
          studentEmail,
          classId,
          description,
          rating,
          image: image || null, // ✅ Image field added
          createdAt,
        };

        const result = await db.collection('feedbacks').insertOne(feedback);
        res.status(201).send({ message: 'Feedback saved', id: result.insertedId });
      } catch (error) {
        console.error('Error saving feedback:', error);
        res.status(500).json({ message: 'Server error' });
      }
    });


    app.get('/api/feedbacks', async (req, res) => {
      try {
        const feedbacks = await db.collection("feedbacks").find().sort({ createdAt: -1 }).limit(10).toArray();
        res.send(feedbacks);
      } catch (error) {
        console.error('❌ Feedback load error:', error);
        res.status(500).send({ message: 'Server error' });
      }
    });

    // Start server
    app.listen(port, () => {
      console.log(`✅ Server running at http://localhost:${port}`);
    });
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1); // stop app if DB not connected
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
