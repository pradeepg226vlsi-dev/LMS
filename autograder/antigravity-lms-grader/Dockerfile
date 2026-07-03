# Use Python 3.9 Debian-based base image
FROM python:3.9

# Install system dependencies (git, verilator, compilers) as root
RUN apt-get update && apt-get install -y \
    verilator \
    git \
    bc \
    bison \
    flex \
    && rm -rf /var/lib/apt/lists/*

# Set up user permissions for Hugging Face security requirements
RUN useradd -m -u 1000 user
USER user
ENV PATH="/home/user/.local/bin:$PATH"

WORKDIR /app

# Install Python requirements
COPY --chown=user ./requirements.txt requirements.txt
RUN pip install --no-cache-dir --upgrade -r requirements.txt

# Copy all application files
COPY --chown=user . /app

# Run uvicorn on port 7860 (Hugging Face expects port 7860)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]
