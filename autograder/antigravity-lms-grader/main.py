import os
import shutil
import asyncio
import subprocess
import glob
import logging
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests
from huggingface_hub import InferenceClient

# Setup Logger
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("autograder")

app = FastAPI(title="Antigravity LMS Autograder Engine")

# Enable CORS for frontend website access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Concurrency lock to sequentialize evaluations and prevent CPU overflow
grading_lock = asyncio.Lock()

class GradeRequest(BaseModel):
    student_id: str
    repo_url: str
    commit_hash: str
    apps_script_url: str
    student_comments: str = ""
    assignment_description: str = ""
    assignment_instructions: str = ""

@app.get("/")
def read_root():
    return {"status": "online", "engine": "Verilator + Qwen2.5-Coder Evaluation Engine"}

@app.post("/grade-commit")
async def grade_commit(req: GradeRequest):
    # Acquire the lock to run evaluations sequentially
    async with grading_lock:
        logger.info(f"Starting autograde sequence for student {req.student_id}, commit {req.commit_hash}")
        
        target_dir = f"repo_{req.student_id}"
        verilator_logs = ""
        verilator_success = False
        ai_feedback = ""
        status = "PASSED"
        
        try:
            # 1. Cleanup pre-existing directory
            if os.path.exists(target_dir):
                shutil.rmtree(target_dir)
                
            # 2. Git Clone and Checkout specific commit
            repo_url = req.repo_url
            git_token = os.environ.get("GITHUB_TOKEN")
            if git_token and "github.com" in repo_url:
                # Inject token to authenticate and clone private repositories
                repo_url = repo_url.replace("https://github.com/", f"https://{git_token}@github.com/")
                
            clone_cmd = ["git", "clone", repo_url, target_dir]
            logger.info(f"Running command: git clone <url> {target_dir} (token injected if present)")
            subprocess.run(clone_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            checkout_cmd = ["git", "-C", target_dir, "checkout", req.commit_hash]
            logger.info(f"Running command: {' '.join(checkout_cmd)}")
            subprocess.run(checkout_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            # 3. Locate all Verilog (.v) and SystemVerilog (.sv) files in the cloned repository
            hw_files = []
            for ext in ("/**/*.v", "/**/*.sv"):
                hw_files.extend(glob.glob(target_dir + ext, recursive=True))
                
            if not hw_files:
                status = "FAILED"
                ai_feedback = "0/10 | Evaluation Error: No hardware files (.v or .sv) found in the repository."
                verilator_logs = "No source files found."
            else:
                logger.info(f"Discovered hardware files: {hw_files}")
                
                # 4. Compile check using Verilator
                compile_cmd = ["verilator", "--binary", "-Wall"] + hw_files
                logger.info(f"Running compiler: {' '.join(compile_cmd)}")
                
                proc = subprocess.run(compile_cmd, capture_output=True, text=True)
                verilator_logs = proc.stderr if proc.stderr else proc.stdout
                verilator_success = (proc.returncode == 0)
                
                # Truncate logs if excessively long
                if len(verilator_logs) > 5000:
                    verilator_logs = verilator_logs[:5000] + "\n... [truncated]"
                
                # 5. AI Grading evaluation (run in all cases to provide marks and feedback even if compilation fails)
                status = "Reviewed"
                
                # Read code contents of discovered files for LLM prompt context
                code_contents = []
                for fpath in hw_files:
                    try:
                        with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                            code_contents.append(f"// FILE: {os.path.basename(fpath)}\n" + f.read())
                    except Exception as e:
                        logger.error(f"Error reading file {fpath}: {str(e)}")
                
                code_context = "\n\n".join(code_contents)
                if len(code_context) > 12000:
                    code_context = code_context[:12000] + "\n... [truncated]"
                
                # Call Hugging Face Serverless Inference API
                hf_token = os.environ.get("HF_TOKEN")
                if not hf_token:
                    raise ValueError("HF_TOKEN secret is missing in the environment.")
                    
                client = InferenceClient(provider="hf-inference", token=hf_token)
                
                system_prompt = (
                    "You are an expert hardware design engineering professor. Evaluate the following Verilog/SystemVerilog "
                    "code submission. Your score (out of 100) must depend directly on: code logic correctness, code readability/style, "
                    "optimization, and compiler results.\n"
                    "If something is wrong or sub-optimal in the code, you MUST explain exactly WHAT is wrong and WHY it is wrong in the feedback.\n"
                    "Inspect the code for key design flaws:\n"
                    "1. Mixing blocking (=) and non-blocking (<=) assignments in sequential/combinational blocks.\n"
                    "2. Unintentional latches (incomplete if-else or case statements in combinational always blocks).\n"
                    "3. Race conditions and clock domain issues.\n\n"
                    "If the Verilator compilation failed, do not assign a flat 0/100. Instead, evaluate the rest of the code's logic, "
                    "readability, structure, and optimization. Assign a partial/failing score (e.g. 10-40 out of 100) based on the code's remaining "
                    "quality, and explain in your feedback how the student can resolve the compiler errors.\n"
                    "Ensure the score correctly reflects the quality of the logic, formatting, and optimization.\n"
                    "Keep your remarks clear, constructive, and concise (max 3-4 sentences). Do not write a long essay.\n"
                    "Your output must follow this format strictly:\n"
                    "[Score]/100 | [Feedback]\n"
                    "Example:\n"
                    "70/100 | The logic is mostly correct, but mixing blocking and non-blocking assignments in the sequential block is wrong because it can cause race conditions in simulation. Additionally, formatting is inconsistent."
                )
                
                user_prompt = f"Submitter ID: {req.student_id}\n"
                if req.assignment_description:
                    user_prompt += f"Assignment Question / Goal:\n{req.assignment_description}\n\n"
                if req.assignment_instructions:
                    user_prompt += f"Assignment Reference Instructions:\n{req.assignment_instructions}\n\n"
                if req.student_comments:
                    user_prompt += f"Student Notes / Implementation Description:\n{req.student_comments}\n\n"
                
                # Add compilation info to prompt
                user_prompt += f"Verilator Compilation Status: {'PASSED' if verilator_success else 'FAILED'}\n"
                if not verilator_success:
                    user_prompt += f"Verilator Compiler Error Logs:\n{verilator_logs}\n\n"
                
                user_prompt += f"Code Files Content:\n{code_context}"
                
                logger.info("Requesting evaluation from Qwen LLM...")
                response = client.chat.completions.create(
                    model="Qwen/Qwen2.5-Coder-7B-Instruct",
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    max_tokens=400
                )
                
                ai_feedback = response.choices[0].message.content.strip()
                logger.info(f"AI response received: {ai_feedback}")
                
                # Sanitize score in ai_feedback to not cross 100
                try:
                    parts = ai_feedback.split("|", 1)
                    if len(parts) >= 2:
                        score_part = parts[0].strip()
                        feedback_part = parts[1].strip()
                        import re
                        match = re.search(r"(\d+)/(100|10)", score_part)
                        if match:
                            score_val = int(match.group(1))
                            max_val = int(match.group(2))
                            if max_val == 10:
                                score_val = score_val * 10
                            # Clamp between 0 and 100
                            score_val = min(100, max(0, score_val))
                            ai_feedback = f"{score_val}/100 | {feedback_part}"
                except Exception as parse_err:
                    logger.error(f"Error sanitizing AI feedback score: {str(parse_err)}")
                    
        except subprocess.CalledProcessError as git_err:
            logger.error(f"Git check/checkout failed: {str(git_err)}")
            status = "ERROR"
            ai_feedback = "0/10 | Git operation failed. Ensure the repo is public and the commit hash is correct."
            verilator_logs = f"Git error occurred."
        except Exception as err:
            logger.error(f"System evaluation error: {str(err)}")
            status = "ERROR"
            ai_feedback = f"0/10 | Autograding pipeline error: {str(err)}"
            verilator_logs = f"Error trace: {str(err)}"
        finally:
            # 6. Post-evaluation clean up to keep container storage at zero
            logger.info("Cleaning up workspace storage...")
            if os.path.exists(target_dir):
                shutil.rmtree(target_dir)
                
        # 7. Deliver callback back to Google Apps Script Web App
        callback_payload = {
            "action": "autogradingCallback",
            "student_id": req.student_id,
            "commit_hash": req.commit_hash,
            "status": status,
            "grading_output": ai_feedback,
            "compiler_logs": verilator_logs[:1000] # send first 1000 characters
        }
        
        logger.info(f"Delivering autograding callback to Apps Script: {callback_payload}")
        try:
            res = requests.post(req.apps_script_url, json=callback_payload, headers={"Content-Type": "text/plain"})
            logger.info(f"Callback status: {res.status_code}, Response: {res.text}")
        except Exception as cb_err:
            logger.error(f"Failed to post callback to Google Sheets backend: {str(cb_err)}")
            
        return {
            "success": True,
            "student_id": req.student_id,
            "status": status,
            "score_feedback": ai_feedback
        }
