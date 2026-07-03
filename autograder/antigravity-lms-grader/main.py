import os
import shutil
import asyncio
import subprocess
import glob
import logging
from fastapi import FastAPI, HTTPException, BackgroundTasks
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
    assignment_title: str = ""
    assignment_description: str = ""
    assignment_instructions: str = ""
    is_late: bool = False

@app.get("/")
def read_root():
    return {"status": "online", "engine": "Verilator + Qwen2.5-Coder Evaluation Engine"}

async def run_grading_workflow(req: GradeRequest):
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
                
                # Read all file contents to supply as LLM prompt context
                code_context = ""
                for file_path in hw_files:
                    try:
                        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                            code_context += f"\n--- File: {os.path.basename(file_path)} ---\n"
                            code_context += f.read()
                    except Exception as read_err:
                        logger.error(f"Could not read {file_path}: {str(read_err)}")
                        
                if len(code_context) > 12000:
                    code_context = code_context[:12000] + "\n... [truncated]"
                
                # Call Hugging Face Serverless Inference API
                hf_token = os.environ.get("HF_TOKEN")
                if not hf_token:
                    raise ValueError("HF_TOKEN secret is missing in the environment.")
                    
                client = InferenceClient(token=hf_token)
                
                system_prompt = (
                    "You are an expert hardware design engineering professor. Evaluate the following Verilog/SystemVerilog "
                    "code submission. Your score (out of 100) must depend directly on: code logic correctness, code readability/style, "
                    "optimization, and compiler results.\n"
                    "If something is wrong or sub-optimal in the code, you MUST explain exactly WHAT is wrong and WHY it is wrong in the feedback.\n"
                    "Inspect the code for key design flaws:\n"
                    "1. Mixing blocking (=) and non-blocking (<=) assignments in sequential/combinational blocks.\n"
                    "2. Unintentional latches (incomplete if-else or case statements in combinational always blocks).\n"
                    "3. Race conditions and clock domain issues.\n\n"
                    "Note: Students may sometimes submit short code snippets instead of complete compilable Verilog modules. "
                    "If the submission is a snippet or if Verilator compilation failed due to missing boilerplate/module definitions, "
                    "do NOT penalize the score for missing headers, wrapper code, or boilerplate. Instead, focus entirely on evaluating "
                    "the core logic, readability, structure, and optimization of the provided snippet. If the core logic is correct and optimal, "
                    "feel free to assign a high score (even up to 100/100 if perfect) and constructively comment on any syntax issues or how to integrate it.\n"
                    "If the compilation failed due to actual syntax or logical errors inside the code itself, assign a reflective partial/failing score (e.g. 10-40 out of 100) and explain how to fix it.\n"
                    "Ensure the score correctly reflects the quality of the logic, formatting, and optimization.\n"
                    "Provide your feedback in less than 100 words. Keep it simple, clear, constructive, and in a natural, understandable human-like tone. Do not write a long essay.\n"
                    "Your output must follow this format strictly:\n"
                    "[Score]/100 | [Feedback]\n"
                    "Example:\n"
                    "70/100 | The logic is mostly correct, but mixing blocking and non-blocking assignments in the sequential block is wrong because it can cause race conditions in simulation. Additionally, formatting is inconsistent."
                )
                
                user_prompt = f"Submitter ID: {req.student_id}\n"
                if req.assignment_title:
                    user_prompt += f"Assignment Title: {req.assignment_title}\n\n"
                if req.assignment_description:
                    user_prompt += f"Assignment Question / Goal:\n{req.assignment_description}\n\n"
                if req.assignment_instructions:
                    user_prompt += f"Assignment Reference Instructions:\n{req.assignment_instructions}\n\n"
                if req.student_comments:
                    user_prompt += f"Student Notes / Implementation Description:\n{req.student_comments}\n\n"
                
                # Add late submission context
                user_prompt += f"Submission Time Status: {'LATE SUBMISSION' if req.is_late else 'ON-TIME SUBMISSION'}\n"
                if req.is_late:
                    user_prompt += "Note: This is a late submission. Apply a deduction of 10 marks (10% penalty) to the final grade score out of 100 for lateness, but still evaluate the code's structural logic, readability, correctness, and optimization fairly.\n\n"
                
                # Add compilation info to prompt
                user_prompt += f"Verilator Compilation Status: {'PASSED' if verilator_success else 'FAILED'}\n"
                if not verilator_success:
                    user_prompt += f"Verilator Compiler Error Logs:\n{verilator_logs}\n\n"
                
                user_prompt += f"Code Files Content:\n{code_context}"
                
                import time
                import random
                
                max_retries = 10
                backoff_factor = 2
                ai_feedback = ""
                
                for attempt in range(max_retries):
                    try:
                        logger.info(f"Requesting evaluation from Qwen LLM (Attempt {attempt + 1}/{max_retries})...")
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
                        break
                    except Exception as llm_err:
                        err_msg = str(llm_err).lower()
                        is_rate_limit = "429" in err_msg or "rate limit" in err_msg or "too many requests" in err_msg
                        
                        if is_rate_limit and attempt < max_retries - 1:
                            sleep_time = (backoff_factor ** attempt) + (random.random() * 2)
                            logger.warning(f"Rate limited (429) by Hugging Face. Retrying in {sleep_time:.2f} seconds...")
                            time.sleep(sleep_time)
                        else:
                            raise llm_err
                
                # Sanitize score and feedback in ai_feedback to strictly follow [Score]/100 | [Feedback]
                try:
                    import re
                    score_match = re.search(r"(\d+)/(100|10)", ai_feedback)
                    if score_match:
                        score_val = int(score_match.group(1))
                        max_val = int(score_match.group(2))
                        if max_val == 10:
                            score_val = score_val * 10
                        score_val = min(100, max(0, score_val))
                        
                        # Strip score-related lines to find clean feedback
                        lines = [line.strip() for line in ai_feedback.split("\n") if line.strip()]
                        clean_lines = []
                        for line in lines:
                            if re.search(r"\d+/(100|10)", line) and ("score" in line.lower() or "grade" in line.lower() or "deduction" in line.lower()):
                                  continue
                            clean_lines.append(line)
                        
                        feedback_text = " ".join(clean_lines)
                        feedback_text = re.sub(r"^(-\s*\*\*Feedback\*\*:\s*|Feedback:\s*|-\s*Feedback\s*|Feedback\s*|-\s*\*\*Comments\*\*:\s*)", "", feedback_text, flags=re.IGNORECASE).strip()
                        
                        ai_feedback = f"{score_val}/100 | {feedback_text}"
                except Exception as parse_err:
                    logger.error(f"Error sanitizing AI feedback score: {str(parse_err)}")
                    
        except subprocess.CalledProcessError as git_err:
            logger.error(f"Git check/checkout failed: {str(git_err)}")
            status = "ERROR"
            ai_feedback = "0/100 | Git operation failed. Ensure the repo is public and the commit hash is correct."
            verilator_logs = f"Git error occurred."
        except Exception as err:
            logger.error(f"System evaluation error: {str(err)}")
            status = "ERROR"
            ai_feedback = f"0/100 | Autograding pipeline error: {str(err)}"
        finally:
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

@app.post("/grade-commit")
async def grade_commit(req: GradeRequest, background_tasks: BackgroundTasks):
    logger.info(f"Received grade request for {req.student_id}. Enqueueing task in background.")
    background_tasks.add_task(run_grading_workflow, req)
    return {
        "success": True,
        "message": "Evaluation successfully queued. The grading status will update shortly on your dashboard."
    }
